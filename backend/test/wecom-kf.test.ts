import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptWechatMessage, decryptWechatMessage, verifyMsgSignature } from "../src/wechat-mp";
import {
  wecomKfConfigured,
  parseWecomKfCallback,
  getWecomAccessToken,
  syncKfMessages,
  sendKfText,
  downloadWecomMedia,
  consumeBindCodeKf,
  lookupKfBinding,
  getKfState,
  setKfState,
  type KfMessage,
} from "../src/wecom-kf";
import { app } from "../src/index";
import type { Env } from "../src/types";

const TOKEN = "test-kf-token";
const AES_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP1";
const CORP_ID = "ww1234567890abcdef";

// helper: compute msg_signature the way WeCom does
async function sign(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(parts.sort().join("")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- stateful fake D1 covering bindings / bind codes / kf state / notes ----

interface FakeState {
  bindings: Map<string, string>;
  codes: Map<string, { user_id: string; expires_at: string }>;
  kfState: Map<string, string>;
  notes: { user_id: string; content: string; source: string; raw_type?: string }[];
}

const freshState = (): FakeState => ({
  bindings: new Map(),
  codes: new Map(),
  kfState: new Map(),
  notes: [],
});

function fakeDb(state: FakeState) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM wecom_kf_bindings")) {
            const uid = state.bindings.get(binds[0] as string);
            return uid ? { user_id: uid } : null;
          }
          if (sql.includes("FROM wechat_mp_bind_codes")) {
            const row = state.codes.get(binds[0] as string);
            return row ? { user_id: row.user_id } : null;
          }
          if (sql.includes("FROM wecom_kf_state")) {
            const v = state.kfState.get(binds[0] as string);
            return v !== undefined ? { v } : null;
          }
          if (sql.includes("FROM notes")) {
            const n = state.notes[state.notes.length - 1];
            return n
              ? { id: "n1", user_id: n.user_id, source: n.source, raw_type: n.raw_type ?? "text", content: n.content, tags: "[]", meta: null, is_sensitive: 0, content_enc: null, category: null, url: null }
              : null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO notes")) {
            state.notes.push({ user_id: binds[1] as string, content: binds[4] as string, source: binds[2] as string, raw_type: binds[3] as string });
          }
          if (sql.startsWith("INSERT INTO wecom_kf_bindings")) {
            state.bindings.set(binds[0] as string, binds[1] as string);
          }
          if (sql.startsWith("INSERT INTO wecom_kf_state")) {
            state.kfState.set(binds[0] as string, binds[1] as string);
          }
          if (sql.startsWith("DELETE FROM wechat_mp_bind_codes WHERE code")) {
            state.codes.delete(binds[0] as string);
          }
          if (sql.startsWith("DELETE FROM wecom_kf_bindings WHERE external_userid")) {
            state.bindings.delete(binds[0] as string);
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(state: FakeState, extra: Record<string, string> = {}): Env {
  return {
    DB: fakeDb(state),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    AI_MODEL: "mock",
    WECOM_KF_TOKEN: TOKEN,
    WECOM_KF_AES_KEY: AES_KEY,
    WECOM_CORP_ID: CORP_ID,
    WECOM_KF_SECRET: "kf-secret",
    ...extra,
  } as unknown as Env;
}

// ---- WeCom API fetch mock: gettoken / sync_msg / send_msg / media/get ----

interface FetchLog {
  sent: { touser: string; content: string }[];
  syncCalls: object[];
  msgQueue: KfMessage[];
  media: Map<string, { bytes: Uint8Array; mime: string; filename?: string }>;
}

function installFetchMock(log: FetchLog) {
  const orig = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/cgi-bin/gettoken")) {
      return Response.json({ errcode: 0, access_token: "ATOKEN", expires_in: 7200 });
    }
    if (url.includes("/cgi-bin/kf/sync_msg")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as object;
      log.syncCalls.push(body);
      const msgs = log.msgQueue.splice(0);
      return Response.json({ errcode: 0, msg_list: msgs, next_cursor: "CUR1", has_more: 0 });
    }
    if (url.includes("/cgi-bin/kf/send_msg")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { touser: string; text: { content: string } };
      log.sent.push({ touser: body.touser, content: body.text.content });
      return Response.json({ errcode: 0, msgid: "m" });
    }
    if (url.includes("/cgi-bin/media/get")) {
      const mediaId = new URL(url).searchParams.get("media_id")!;
      const m = log.media.get(mediaId);
      if (!m) return Response.json({ errcode: 40007, errmsg: "invalid media_id" }, { headers: { "content-type": "application/json" } });
      const headers: Record<string, string> = { "content-type": m.mime };
      if (m.filename) headers["content-disposition"] = `attachment; filename="${m.filename}"`;
      return new Response(m.bytes.buffer as ArrayBuffer, { headers });
    }
    return orig(input as never, init);
  });
}

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function kfEventXml(): string {
  return (
    `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><CreateTime>123</CreateTime>` +
    `<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event>` +
    `<Token><![CDATA[SYNCTOKEN]]></Token><OpenKfId><![CDATA[wkAAA]]></OpenKfId></xml>`
  );
}

async function postKf(env: Env): Promise<Response> {
  const enc = await encryptWechatMessage(AES_KEY, kfEventXml(), CORP_ID);
  const ts = "111", nonce = "222";
  const msgSig = await sign([TOKEN, ts, nonce, enc!]);
  const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
  // capture waitUntil promises so the test can await background processing
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const res = await app.request(
    `/wechat/kf?timestamp=${ts}&nonce=${nonce}&msg_signature=${msgSig}`,
    { method: "POST", body, headers: { "content-type": "application/xml" } },
    env,
    ctx
  );
  while (pending.length) await pending.shift();
  return res;
}

function textMsg(externalUserid: string, content: string): KfMessage {
  return { msgid: crypto.randomUUID(), open_kfid: "wkAAA", external_userid: externalUserid, send_time: 1, origin: 3, msgtype: "text", text: { content } };
}

describe("wecom kf helpers", () => {
  it("wecomKfConfigured requires token + aes key + corp id + secret", () => {
    const state = freshState();
    expect(wecomKfConfigured(makeEnv(state))).toBe(true);
    expect(wecomKfConfigured(makeEnv(state, { WECOM_KF_TOKEN: "" }))).toBe(false);
    expect(wecomKfConfigured(makeEnv(state, { WECOM_CORP_ID: "" }))).toBe(false);
    // sync/send both need the corp secret: half-configured must read as "off" (R113)
    expect(wecomKfConfigured(makeEnv(state, { WECOM_KF_SECRET: "" }))).toBe(false);
  });

  it("parses the kf callback xml", () => {
    const cb = parseWecomKfCallback(kfEventXml());
    expect(cb).toMatchObject({ toUserName: CORP_ID, event: "kf_msg_or_event", token: "SYNCTOKEN", openKfId: "wkAAA" });
    expect(parseWecomKfCallback("<xml></xml>")).toBeNull();
  });

  it("kf state get/set roundtrip", async () => {
    const state = freshState();
    const db = fakeDb(state);
    expect(await getKfState(db, "k1")).toBeNull();
    await setKfState(db, "k1", "v1");
    expect(await getKfState(db, "k1")).toBe("v1");
  });
});

describe("wecom kf token / api calls (mocked fetch)", () => {
  let log: FetchLog;
  beforeEach(() => {
    log = { sent: [], syncCalls: [], msgQueue: [], media: new Map() };
    installFetchMock(log);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("caches the access_token in D1 and reuses it", async () => {
    const state = freshState();
    const env = makeEnv(state);
    expect(await getWecomAccessToken(env)).toBe("ATOKEN");
    const stored = JSON.parse(state.kfState.get("access_token")!) as { token: string; expiresAt: number };
    expect(stored.token).toBe("ATOKEN");
    // poison the network response: cached token must still be returned
    stored.token = "CACHED";
    state.kfState.set("access_token", JSON.stringify(stored));
    expect(await getWecomAccessToken(env)).toBe("CACHED");
  });

  it("returns null without corp credentials", async () => {
    const env = makeEnv(freshState(), { WECOM_KF_SECRET: "" });
    expect(await getWecomAccessToken(env)).toBeNull();
  });

  it("sync_msg passes token/kfid and persists the cursor", async () => {
    const state = freshState();
    const env = makeEnv(state);
    log.msgQueue.push(textMsg("extU1", "hello"));
    const msgs = await syncKfMessages(env, "SYNCTOKEN", "wkAAA");
    expect(msgs).toHaveLength(1);
    expect(log.syncCalls[0]).toMatchObject({ token: "SYNCTOKEN", open_kfid: "wkAAA" });
    expect(state.kfState.get("cursor:wkAAA")).toBe("CUR1");
    // next sync resumes from the stored cursor
    await syncKfMessages(env, "SYNCTOKEN2", "wkAAA");
    expect(log.syncCalls[1]).toMatchObject({ cursor: "CUR1" });
  });

  it("sendKfText posts to send_msg", async () => {
    const env = makeEnv(freshState());
    expect(await sendKfText(env, "wkAAA", "extU1", "hi")).toBe(true);
    expect(log.sent[0]).toEqual({ touser: "extU1", content: "hi" });
  });

  it("downloadWecomMedia returns bytes + filename from content-disposition", async () => {
    const env = makeEnv(freshState());
    log.media.set("m1", { bytes: new TextEncoder().encode("hello file"), mime: "text/markdown", filename: "note.md" });
    const media = await downloadWecomMedia(env, "m1");
    expect(media).not.toBeNull();
    expect(media!.filename).toBe("note.md");
    expect(new TextDecoder().decode(media!.bytes)).toBe("hello file");
    expect(await downloadWecomMedia(env, "missing")).toBeNull();
  });
});

describe("wecom kf binding", () => {
  it("consumes a valid bind code and rejects expired/unknown ones", async () => {
    const state = freshState();
    state.codes.set("123456", { user_id: "u_qa", expires_at: "2099-01-01 00:00:00" });
    const db = fakeDb(state);
    expect(await consumeBindCodeKf(db, "999999", "extU1")).toBeNull();
    expect(await consumeBindCodeKf(db, "123456", "extU1")).toBe("u_qa");
    expect(state.bindings.get("extU1")).toBe("u_qa");
    expect(await lookupKfBinding(db, "extU1")).toBe("u_qa");
    expect(await lookupKfBinding(db, "extU2")).toBeNull();
  });
});

describe("/wechat/kf endpoint", () => {
  let log: FetchLog;
  beforeEach(() => {
    log = { sent: [], syncCalls: [], msgQueue: [], media: new Map() };
    installFetchMock(log);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is 404 when WECOM_KF_* secrets are unset (feature off by default)", async () => {
    const env = { DB: fakeDb(freshState()), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
    expect((await app.request("/wechat/kf?echostr=x", {}, env, execCtx)).status).toBe(404);
    expect((await app.request("/wechat/kf", { method: "POST", body: "<xml/>" }, env, execCtx)).status).toBe(404);
  });

  it("GET verifies msg_signature and returns the decrypted echostr", async () => {
    const env = makeEnv(freshState());
    const enc = await encryptWechatMessage(AES_KEY, "PLAIN-ECHO", CORP_ID);
    const ts = "111", nonce = "222";
    const sig = await sign([TOKEN, ts, nonce, enc!]);
    const ok = await app.request(
      `/wechat/kf?timestamp=${ts}&nonce=${nonce}&msg_signature=${sig}&echostr=${encodeURIComponent(enc!)}`,
      {},
      env,
      execCtx
    );
    expect(await ok.text()).toBe("PLAIN-ECHO");
    const bad = await app.request(`/wechat/kf?timestamp=${ts}&nonce=${nonce}&msg_signature=bad&echostr=${encodeURIComponent(enc!)}`, {}, env, execCtx);
    expect(bad.status).toBe(403);
  });

  it("POST rejects a bad signature and malformed body", async () => {
    const env = makeEnv(freshState());
    const enc = await encryptWechatMessage(AES_KEY, kfEventXml(), CORP_ID);
    const res = await app.request(
      `/wechat/kf?timestamp=111&nonce=222&msg_signature=bad`,
      { method: "POST", body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>` },
      env,
      execCtx
    );
    expect(res.status).toBe(403);
    const res2 = await app.request(`/wechat/kf?timestamp=111&nonce=222&msg_signature=x`, { method: "POST", body: "<xml/>" }, env, execCtx);
    expect(res2.status).toBe(400);
  });

  it("unbound user gets bind help; valid code binds; text then ingests and is searchable", async () => {
    const state = freshState();
    state.codes.set("123456", { user_id: "u_qa", expires_at: "2099-01-01 00:00:00" });
    const env = makeEnv(state);

    log.msgQueue.push(textMsg("extU1", "随便说点什么"));
    expect((await postKf(env)).status).toBe(200);
    expect(log.sent.at(-1)!.content).toContain("绑定码");

    log.msgQueue.push(textMsg("extU1", "绑定 123456"));
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("绑定成功");
    expect(state.bindings.get("extU1")).toBe("u_qa");

    log.msgQueue.push(textMsg("extU1", "买牛奶 #生活"));
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("已存");
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]).toMatchObject({ user_id: "u_qa", source: "wechat", content: "买牛奶 #生活" });
  });

  it("link message ingests as a link note", async () => {
    const state = freshState();
    state.bindings.set("extU2", "u_qa");
    const env = makeEnv(state);
    log.msgQueue.push({
      msgid: "L1", open_kfid: "wkAAA", external_userid: "extU2", send_time: 1, origin: 3,
      msgtype: "link", link: { title: "一篇好文章", desc: "摘要", url: "https://example.com/a" },
    });
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("链接已存");
    expect(state.notes.at(-1)!.content).toContain("https://example.com/a");
    expect(state.notes.at(-1)).toMatchObject({ raw_type: "link" });
  });

  it("file message downloads media, extracts text, stores the note", async () => {
    const state = freshState();
    state.bindings.set("extU3", "u_qa");
    const env = makeEnv(state);
    log.media.set("F1", { bytes: new TextEncoder().encode("# 会议纪要\n重要结论"), mime: "text/markdown", filename: "notes.md" });
    log.msgQueue.push({
      msgid: "F1msg", open_kfid: "wkAAA", external_userid: "extU3", send_time: 1, origin: 3,
      msgtype: "file", file: { media_id: "F1", filename: "notes.md" },
    });
    await postKf(env);
    expect(state.notes.at(-1)!.content).toContain("会议纪要");
    expect(state.notes.at(-1)).toMatchObject({ raw_type: "file" });
    expect(log.sent.some((s) => s.content.includes("已存档"))).toBe(true);
  });

  it("voice message downloads media and stores the transcript placeholder when transcription unavailable", async () => {
    const state = freshState();
    state.bindings.set("extU4", "u_qa");
    const env = makeEnv(state);
    log.media.set("V1", { bytes: new Uint8Array([1, 2, 3]), mime: "audio/amr" });
    log.msgQueue.push({
      msgid: "V1msg", open_kfid: "wkAAA", external_userid: "extU4", send_time: 1, origin: 3,
      msgtype: "voice", voice: { media_id: "V1" },
    });
    await postKf(env);
    // no Whisper binding in tests: placeholder note still stored, raw_type voice
    expect(state.notes.at(-1)).toMatchObject({ raw_type: "voice", user_id: "u_qa" });
    expect(log.sent.at(-1)!.content).toContain("语音已收到");
  });

  it("miniprogram card stored as text; unsupported types get a friendly reply; 解绑 removes binding", async () => {
    const state = freshState();
    state.bindings.set("extU5", "u_qa");
    const env = makeEnv(state);

    log.msgQueue.push({
      msgid: "MP1", open_kfid: "wkAAA", external_userid: "extU5", send_time: 1, origin: 3,
      msgtype: "miniprogram", miniprogram: { appid: "wxapp1", title: "点餐小程序", pagepath: "pages/index" },
    });
    await postKf(env);
    expect(state.notes.at(-1)!.content).toContain("点餐小程序");

    log.msgQueue.push({
      msgid: "VID1", open_kfid: "wkAAA", external_userid: "extU5", send_time: 1, origin: 3,
      msgtype: "video", video: { media_id: "x" },
    });
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("暂不支持");

    log.msgQueue.push(textMsg("extU5", "解绑"));
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("已解绑");
    expect(state.bindings.has("extU5")).toBe(false);
  });

  it("? questions get the web hint instead of being stored; agent-origin messages are ignored", async () => {
    const state = freshState();
    state.bindings.set("extU6", "u_qa");
    const env = makeEnv(state);
    log.msgQueue.push(textMsg("extU6", "？我最近在想什么"));
    await postKf(env);
    expect(log.sent.at(-1)!.content).toContain("问一问");
    expect(state.notes).toHaveLength(0);

    log.msgQueue.push({ ...textMsg("extU6", "客服回复内容"), origin: 4 });
    await postKf(env);
    expect(state.notes).toHaveLength(0);
  });

  it("AES envelope roundtrip matches wecom scheme (receiver id = corp id)", async () => {
    const enc = await encryptWechatMessage(AES_KEY, "<xml>x</xml>", CORP_ID);
    expect(await decryptWechatMessage(AES_KEY, enc!, CORP_ID)).toBe("<xml>x</xml>");
    expect(await decryptWechatMessage(AES_KEY, enc!, "ww_other")).toBeNull();
    const sig = await sign([TOKEN, "1", "2", enc!]);
    expect(await verifyMsgSignature(TOKEN, "1", "2", enc!, sig)).toBe(true);
  });
});
