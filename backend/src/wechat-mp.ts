// WeChat Official Account (微信公众号) server-side integration (R85).
//
// The official message API works for every account tier including the free
// personal 订阅号 and the sandbox 测试号: WeChat POSTs each incoming message as
// XML to our callback URL, and we answer with a passive-reply XML within 5s.
// Endpoint is disabled (404) unless WECHAT_MP_TOKEN is configured, so
// self-hosters without an official account are unaffected.
//
// Supports both plaintext mode and safe (AES) mode: when WECHAT_MP_AES_KEY is
// set and the request carries encrypt_type=aes, the inner <Encrypt> payload is
// AES-256-CBC decrypted / the reply re-encrypted per the official scheme
// (16-byte random prefix + 4-byte big-endian length + xml + appid, PKCS#7).

import type { Env } from "./types";

// ---- signature ----

async function sha1Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Plaintext-mode signature: sha1(sort(token, timestamp, nonce)). */
export async function verifySignature(token: string, timestamp: string, nonce: string, signature: string): Promise<boolean> {
  if (!token || !timestamp || !nonce || !signature) return false;
  const expected = await sha1Hex([token, timestamp, nonce].sort().join(""));
  return expected === signature.toLowerCase();
}

/** Safe-mode signature: sha1(sort(token, timestamp, nonce, encrypt)). */
export async function verifyMsgSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  msgSignature: string
): Promise<boolean> {
  if (!token || !timestamp || !nonce || !encrypt || !msgSignature) return false;
  const expected = await sha1Hex([token, timestamp, nonce, encrypt].sort().join(""));
  return expected === msgSignature.toLowerCase();
}

// ---- AES (safe mode) ----

function b64decodeBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64encodeBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The 43-char EncodingAESKey decodes (with "=" padding) to a 32-byte AES key. */
function decodeAesKey(encodingAesKey: string): Uint8Array {
  return b64decodeBytes(encodingAesKey + "=");
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, "AES-CBC", false, ["encrypt", "decrypt"]);
}

/**
 * Decrypt a safe-mode <Encrypt> payload. Returns the inner XML, or null on
 * bad key / corrupt data / appid mismatch (when expectedAppId is provided).
 */
export async function decryptWechatMessage(
  encodingAesKey: string,
  encryptedB64: string,
  expectedAppId?: string
): Promise<string | null> {
  try {
    const keyBytes = decodeAesKey(encodingAesKey);
    if (keyBytes.length !== 32) return null;
    const key = await importAesKey(keyBytes);
    const iv = keyBytes.slice(0, 16);
    const cipher = b64decodeBytes(encryptedB64);
    // WebCrypto AES-CBC always strips PKCS#7 padding, matching WeChat's scheme
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv.buffer as ArrayBuffer }, key, cipher.buffer as ArrayBuffer);
    const plain = new Uint8Array(plainBuf);
    if (plain.length < 20) return null;
    const msgLen = (plain[16] << 24) | (plain[17] << 16) | (plain[18] << 8) | plain[19];
    if (msgLen < 0 || 20 + msgLen > plain.length) return null;
    const xml = new TextDecoder().decode(plain.slice(20, 20 + msgLen));
    const appId = new TextDecoder().decode(plain.slice(20 + msgLen));
    if (expectedAppId && appId !== expectedAppId) return null;
    return xml;
  } catch {
    return null;
  }
}

/** Encrypt a reply XML for safe mode. Returns base64 ciphertext, or null on bad key. */
export async function encryptWechatMessage(encodingAesKey: string, xml: string, appId: string): Promise<string | null> {
  try {
    const keyBytes = decodeAesKey(encodingAesKey);
    if (keyBytes.length !== 32) return null;
    const key = await importAesKey(keyBytes);
    const iv = keyBytes.slice(0, 16);
    const random = crypto.getRandomValues(new Uint8Array(16));
    const xmlBytes = new TextEncoder().encode(xml);
    const appIdBytes = new TextEncoder().encode(appId);
    const buf = new Uint8Array(16 + 4 + xmlBytes.length + appIdBytes.length);
    buf.set(random, 0);
    buf[16] = (xmlBytes.length >>> 24) & 0xff;
    buf[17] = (xmlBytes.length >>> 16) & 0xff;
    buf[18] = (xmlBytes.length >>> 8) & 0xff;
    buf[19] = xmlBytes.length & 0xff;
    buf.set(xmlBytes, 20);
    buf.set(appIdBytes, 20 + xmlBytes.length);
    const cipher = await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv.buffer as ArrayBuffer }, key, buf.buffer as ArrayBuffer);
    return b64encodeBytes(new Uint8Array(cipher));
  } catch {
    return null;
  }
}

/** Build the safe-mode reply envelope (Encrypt + MsgSignature + TimeStamp + Nonce). */
export async function buildEncryptedReply(token: string, encryptedB64: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const sig = await sha1Hex([token, timestamp, nonce, encryptedB64].sort().join(""));
  return (
    `<xml><Encrypt><![CDATA[${encryptedB64}]]></Encrypt>` +
    `<MsgSignature><![CDATA[${sig}]]></MsgSignature>` +
    `<TimeStamp>${timestamp}</TimeStamp>` +
    `<Nonce><![CDATA[${nonce}]]></Nonce></xml>`
  );
}

// ---- XML parse / build ----

export interface WechatIncomingMessage {
  toUserName: string;
  fromUserName: string;
  msgType: string;
  content?: string;
  picUrl?: string;
  mediaId?: string;
  format?: string;
  recognition?: string;
  event?: string;
  title?: string;
  description?: string;
  url?: string;
  msgId?: string;
}

function xmlField(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${tag}>`));
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? "").trim() || undefined;
}

/**
 * Parse the WeChat message XML with targeted per-field regexes. The payload
 * shape is fixed and flat (official docs), so a full XML parser dependency is
 * unnecessary in the Workers runtime.
 */
export function parseWechatXml(xml: string): WechatIncomingMessage | null {
  const toUserName = xmlField(xml, "ToUserName");
  const fromUserName = xmlField(xml, "FromUserName");
  const msgType = xmlField(xml, "MsgType");
  if (!toUserName || !fromUserName || !msgType) return null;
  return {
    toUserName,
    fromUserName,
    msgType,
    content: xmlField(xml, "Content"),
    picUrl: xmlField(xml, "PicUrl"),
    mediaId: xmlField(xml, "MediaId"),
    format: xmlField(xml, "Format"),
    recognition: xmlField(xml, "Recognition"),
    event: xmlField(xml, "Event"),
    title: xmlField(xml, "Title"),
    description: xmlField(xml, "Description"),
    url: xmlField(xml, "Url"),
    msgId: xmlField(xml, "MsgId"),
  };
}

/** Passive text reply. `to`/`from` are already swapped by the caller. */
export function buildTextReply(toOpenId: string, fromAccount: string, content: string): string {
  return (
    `<xml><ToUserName><![CDATA[${toOpenId}]]></ToUserName>` +
    `<FromUserName><![CDATA[${fromAccount}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType>` +
    `<Content><![CDATA[${content}]]></Content></xml>`
  );
}

// ---- binding codes ----

export const BIND_CODE_TTL_MINUTES = 10;

/** Generate (and persist) a fresh 6-digit binding code, replacing the user's previous one. */
export async function createBindCode(db: D1Database, userId: string): Promise<{ code: string; expires_at: string }> {
  // best-effort cleanup of expired codes so the table stays tiny
  await db.prepare("DELETE FROM wechat_mp_bind_codes WHERE expires_at < datetime('now')").run();
  await db.prepare("DELETE FROM wechat_mp_bind_codes WHERE user_id = ?").bind(userId).run();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = (100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)).toString();
    const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MINUTES * 60_000).toISOString().replace("T", " ").slice(0, 19);
    try {
      await db
        .prepare("INSERT INTO wechat_mp_bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(code, userId, expiresAt)
        .run();
      return { code, expires_at: expiresAt };
    } catch (e) {
      // rare 6-digit collision with another user's live code: retry with a new code
      if (!/UNIQUE|PRIMARY/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
  throw new Error("bind code generation failed");
}

/** Consume a binding code: returns the owning user id and binds the openid, or null if invalid/expired. */
export async function consumeBindCode(db: D1Database, code: string, openid: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM wechat_mp_bind_codes WHERE code = ? AND expires_at >= datetime('now')")
    .bind(code)
    .first<{ user_id: string }>();
  if (!row) return null;
  await db
    .prepare(
      "INSERT INTO wechat_mp_bindings (openid, user_id) VALUES (?, ?) " +
        "ON CONFLICT(openid) DO UPDATE SET user_id = excluded.user_id, created_at = datetime('now')"
    )
    .bind(openid, row.user_id)
    .run();
  await db.prepare("DELETE FROM wechat_mp_bind_codes WHERE code = ?").bind(code).run();
  return row.user_id;
}

export async function lookupBinding(db: D1Database, openid: string): Promise<string | null> {
  const row = await db.prepare("SELECT user_id FROM wechat_mp_bindings WHERE openid = ?").bind(openid).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Extract a bind code from a message: bare "123456" or "绑定 123456" / "bind 123456". */
export function extractBindCode(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^(?:绑定|bind)?\s*(\d{6})$/i);
  return m ? m[1] : null;
}

// ---- media download (voice / image originals) ----

interface AccessTokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: AccessTokenCache | null = null;

/**
 * Fetch (and memoize per-isolate) the official-account access_token. Only
 * needed for voice-media download; text/image ingest works without it.
 */
export async function getMpAccessToken(env: Env): Promise<string | null> {
  if (!env.WECHAT_MP_APPID || !env.WECHAT_MP_APPSECRET) return null;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  try {
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(env.WECHAT_MP_APPID)}&secret=${encodeURIComponent(env.WECHAT_MP_APPSECRET)}`
    );
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!data.access_token) {
      console.error("wechat mp: token fetch failed", data.errcode, data.errmsg);
      return null;
    }
    tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
    return data.access_token;
  } catch (e) {
    console.error("wechat mp: token fetch error", e);
    return null;
  }
}

/** Download a temp media file (voice/image) by MediaId. Returns bytes + mime, or null. */
export async function downloadMpMedia(env: Env, mediaId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const token = await getMpAccessToken(env);
  if (!token) return null;
  try {
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`
    );
    const mime = res.headers.get("content-type") || "application/octet-stream";
    if (mime.includes("json") || mime.includes("text/plain")) {
      const err = await res.text();
      console.error("wechat mp: media download failed", err.slice(0, 200));
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return { bytes, mime };
  } catch (e) {
    console.error("wechat mp: media download error", e);
    return null;
  }
}
