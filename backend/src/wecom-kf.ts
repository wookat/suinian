// WeCom 微信客服 (WeChat Customer Service) server-side integration (R86).
//
// Unlike the Official Account channel, WeChat users can forward articles
// (link) and files into a 微信客服 session, so this is the official channel
// that covers the "forward into Suinian" use case. Protocol shape:
//   1. WeChat POSTs an encrypted callback event (always AES) to /wechat/kf
//   2. we verify msg_signature, decrypt, and read the sync Token + OpenKfId
//   3. we pull the actual messages with the kf/sync_msg JSON API (cursor-based)
//   4. replies go out via kf/send_msg (48h session window, enforced server-side)
//
// The AES envelope and signature scheme are identical to the 公众号 safe mode
// (the trailing receiver id is the corp_id instead of the appid), so the
// crypto helpers from wechat-mp are reused directly.
//
// Endpoint is disabled (404) unless WECOM_KF_TOKEN / WECOM_KF_AES_KEY /
// WECOM_CORP_ID are all configured, so self-hosters are unaffected.
//
// Workers isolates have no reliable resident memory, so both the corp
// access_token cache and the per-kf-account sync cursor persist in the
// wecom_kf_state D1 table.

import type { Env } from "./types";

/** True when the callback endpoint should be live. */
export function wecomKfConfigured(env: Env): boolean {
  return !!(env.WECOM_KF_TOKEN && env.WECOM_KF_AES_KEY && env.WECOM_CORP_ID && env.WECOM_KF_SECRET);
}

// ---- callback XML ----

export interface WecomKfCallback {
  toUserName: string;
  event?: string;
  /** sync_msg consumption token carried by the kf_msg_or_event callback. */
  token?: string;
  openKfId?: string;
}

function xmlField(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`));
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? "").trim() || undefined;
}

/** Parse the decrypted kf callback XML (kf_msg_or_event events). */
export function parseWecomKfCallback(xml: string): WecomKfCallback | null {
  const toUserName = xmlField(xml, "ToUserName");
  if (!toUserName) return null;
  return {
    toUserName,
    event: xmlField(xml, "Event"),
    token: xmlField(xml, "Token"),
    openKfId: xmlField(xml, "OpenKfID") ?? xmlField(xml, "OpenKfId"),
  };
}

// ---- persistent state (D1-backed KV) ----

export async function getKfState(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT v FROM wecom_kf_state WHERE k = ?").bind(key).first<{ v: string }>();
  return row?.v ?? null;
}

export async function setKfState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO wecom_kf_state (k, v, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime('now')"
    )
    .bind(key, value)
    .run();
}

// ---- corp access_token (cached in D1) ----

const TOKEN_STATE_KEY = "access_token";
const QYAPI = "https://qyapi.weixin.qq.com/cgi-bin";

interface StoredToken {
  token: string;
  expiresAt: number;
}

/**
 * Fetch (or reuse the D1-cached) corp access_token for the 微信客服 secret.
 * Returns null when the corp credentials are missing or rejected.
 */
export async function getWecomAccessToken(env: Env): Promise<string | null> {
  if (!env.WECOM_CORP_ID || !env.WECOM_KF_SECRET) return null;
  try {
    const cached = await getKfState(env.DB, TOKEN_STATE_KEY);
    if (cached) {
      const stored = JSON.parse(cached) as StoredToken;
      if (stored.token && stored.expiresAt > Date.now() + 60_000) return stored.token;
    }
  } catch {
    // corrupt cache: fall through to a fresh fetch
  }
  try {
    const res = await fetch(
      `${QYAPI}/gettoken?corpid=${encodeURIComponent(env.WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(env.WECOM_KF_SECRET)}`
    );
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!data.access_token) {
      console.error("wecom kf: token fetch failed", data.errcode, data.errmsg);
      return null;
    }
    const stored: StoredToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
    await setKfState(env.DB, TOKEN_STATE_KEY, JSON.stringify(stored));
    return data.access_token;
  } catch (e) {
    console.error("wecom kf: token fetch error", e);
    return null;
  }
}

// ---- sync_msg ----

export interface KfMessage {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  /** 3 = sent by the WeChat customer (the only origin we ingest). */
  origin: number;
  msgtype: string;
  text?: { content: string; menu_id?: string };
  image?: { media_id: string };
  voice?: { media_id: string };
  video?: { media_id: string };
  file?: { media_id: string; filename?: string };
  link?: { title?: string; desc?: string; url?: string; pic_url?: string };
  miniprogram?: { appid?: string; title?: string; pagepath?: string; thumb_media_id?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  event?: { event_type?: string; open_kfid?: string; external_userid?: string; welcome_code?: string };
}

interface SyncMsgResponse {
  errcode: number;
  errmsg?: string;
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMessage[];
}

const SYNC_LIMIT = 100;
const SYNC_MAX_PAGES = 10;

/**
 * Pull new customer messages via kf/sync_msg, resuming from the persisted
 * cursor so each message is delivered exactly once across Worker isolates.
 */
export async function syncKfMessages(env: Env, syncToken: string | undefined, openKfId: string | undefined): Promise<KfMessage[]> {
  const accessToken = await getWecomAccessToken(env);
  if (!accessToken) {
    console.error("wecom kf: sync skipped — corp access_token unavailable (WECOM_KF_SECRET configured?)");
    return [];
  }
  const cursorKey = `cursor:${openKfId ?? "default"}`;
  let cursor = (await getKfState(env.DB, cursorKey)) ?? "";
  const out: KfMessage[] = [];
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const body: Record<string, unknown> = { limit: SYNC_LIMIT };
    if (cursor) body.cursor = cursor;
    if (syncToken) body.token = syncToken;
    if (openKfId) body.open_kfid = openKfId;
    let data: SyncMsgResponse;
    try {
      const res = await fetch(`${QYAPI}/kf/sync_msg?access_token=${encodeURIComponent(accessToken)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      data = (await res.json()) as SyncMsgResponse;
    } catch (e) {
      console.error("wecom kf: sync_msg fetch error", e);
      break;
    }
    if (data.errcode !== 0) {
      console.error("wecom kf: sync_msg failed", data.errcode, data.errmsg);
      break;
    }
    out.push(...(data.msg_list ?? []));
    if (data.next_cursor) {
      cursor = data.next_cursor;
      await setKfState(env.DB, cursorKey, cursor);
    }
    if (!data.has_more) break;
  }
  return out;
}

// ---- send_msg (reply within the 48h service window) ----

/**
 * Send a text reply to a customer. WeChat enforces the 48h session window and
 * per-session message quota server-side; on rejection we just log the errcode
 * (95001 = out of window / no quota) — the note itself is already stored.
 */
export async function sendKfText(env: Env, openKfId: string, externalUserid: string, content: string): Promise<boolean> {
  const accessToken = await getWecomAccessToken(env);
  if (!accessToken) return false;
  try {
    const res = await fetch(`${QYAPI}/kf/send_msg?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: externalUserid,
        open_kfid: openKfId,
        msgtype: "text",
        text: { content },
      }),
    });
    const data = (await res.json()) as { errcode: number; errmsg?: string };
    if (data.errcode !== 0) {
      console.error("wecom kf: send_msg failed", data.errcode, data.errmsg);
      return false;
    }
    return true;
  } catch (e) {
    console.error("wecom kf: send_msg error", e);
    return false;
  }
}

// ---- media download ----

/** Download a temp media file (voice/image/file) by media_id. */
export async function downloadWecomMedia(
  env: Env,
  mediaId: string
): Promise<{ bytes: Uint8Array; mime: string; filename: string | null } | null> {
  const accessToken = await getWecomAccessToken(env);
  if (!accessToken) return null;
  try {
    const res = await fetch(
      `${QYAPI}/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`
    );
    const mime = res.headers.get("content-type") || "application/octet-stream";
    if (mime.includes("json") || mime.includes("text/plain")) {
      const err = await res.text();
      console.error("wecom kf: media download failed", err.slice(0, 200));
      return null;
    }
    const disposition = res.headers.get("content-disposition") || "";
    const fm = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const filename = fm ? decodeURIComponent(fm[1].replace(/"$/, "")) : null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return { bytes, mime, filename };
  } catch (e) {
    console.error("wecom kf: media download error", e);
    return null;
  }
}

// ---- binding (shares the R85 bind-code table; separate binding table) ----

/** Consume a binding code for the kf channel: binds external_userid, or null if invalid/expired. */
export async function consumeBindCodeKf(db: D1Database, code: string, externalUserid: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM wechat_mp_bind_codes WHERE code = ? AND expires_at >= datetime('now')")
    .bind(code)
    .first<{ user_id: string }>();
  if (!row) return null;
  await db
    .prepare(
      "INSERT INTO wecom_kf_bindings (external_userid, user_id) VALUES (?, ?) " +
        "ON CONFLICT(external_userid) DO UPDATE SET user_id = excluded.user_id, created_at = datetime('now')"
    )
    .bind(externalUserid, row.user_id)
    .run();
  await db.prepare("DELETE FROM wechat_mp_bind_codes WHERE code = ?").bind(code).run();
  return row.user_id;
}

export async function lookupKfBinding(db: D1Database, externalUserid: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM wecom_kf_bindings WHERE external_userid = ?")
    .bind(externalUserid)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}
