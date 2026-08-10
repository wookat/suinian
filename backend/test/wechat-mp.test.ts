import { describe, it, expect } from "vitest";
import {
  verifySignature,
  verifyMsgSignature,
  decryptWechatMessage,
  encryptWechatMessage,
  buildEncryptedReply,
  parseWechatXml,
  buildTextReply,
  extractBindCode,
} from "../src/wechat-mp";
import { app } from "../src/index";

// helper: compute the plaintext-mode signature the way WeChat does
async function sign(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(parts.sort().join("")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const TOKEN = "test-mp-token";
// valid EncodingAESKey: 43 base64 chars -> 32 bytes
const AES_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP1";
const APPID = "wx1234567890abcdef";

describe("wechat signature", () => {
  it("accepts a correct signature and rejects wrong ones", async () => {
    const sig = await sign([TOKEN, "111", "222"]);
    expect(await verifySignature(TOKEN, "111", "222", sig)).toBe(true);
    expect(await verifySignature(TOKEN, "111", "222", "deadbeef")).toBe(false);
    expect(await verifySignature(TOKEN, "", "222", sig)).toBe(false);
  });

  it("msg_signature includes the encrypted payload", async () => {
    const sig = await sign([TOKEN, "111", "222", "ENC"]);
    expect(await verifyMsgSignature(TOKEN, "111", "222", "ENC", sig)).toBe(true);
    expect(await verifyMsgSignature(TOKEN, "111", "222", "OTHER", sig)).toBe(false);
  });
});

describe("wechat AES safe mode", () => {
  it("encrypt/decrypt roundtrip preserves the xml and checks appid", async () => {
    const xml = "<xml><Content><![CDATA[你好 hello]]></Content></xml>";
    const enc = await encryptWechatMessage(AES_KEY, xml, APPID);
    expect(enc).toBeTruthy();
    expect(await decryptWechatMessage(AES_KEY, enc!, APPID)).toBe(xml);
    // appid mismatch -> null
    expect(await decryptWechatMessage(AES_KEY, enc!, "wx_other")).toBeNull();
  });

  it("rejects a bad key or corrupt ciphertext", async () => {
    expect(await encryptWechatMessage("short", "<xml/>", APPID)).toBeNull();
    expect(await decryptWechatMessage(AES_KEY, "not-base64!!", APPID)).toBeNull();
  });

  it("buildEncryptedReply produces a verifiable envelope", async () => {
    const reply = await buildEncryptedReply(TOKEN, "CIPHERTEXT");
    const ts = reply.match(/<TimeStamp>(\d+)<\/TimeStamp>/)![1];
    const nonce = reply.match(/<Nonce><!\[CDATA\[(.+?)\]\]><\/Nonce>/)![1];
    const sig = reply.match(/<MsgSignature><!\[CDATA\[([0-9a-f]{40})\]\]><\/MsgSignature>/)![1];
    expect(await verifyMsgSignature(TOKEN, ts, nonce, "CIPHERTEXT", sig)).toBe(true);
  });
});

describe("wechat xml parse / build", () => {
  it("parses a text message", () => {
    const msg = parseWechatXml(
      "<xml><ToUserName><![CDATA[gh_acct]]></ToUserName><FromUserName><![CDATA[openid1]]></FromUserName>" +
        "<CreateTime>123</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[记一条 想法]]></Content>" +
        "<MsgId>456</MsgId></xml>"
    );
    expect(msg).toMatchObject({ toUserName: "gh_acct", fromUserName: "openid1", msgType: "text", content: "记一条 想法", msgId: "456" });
  });

  it("parses voice recognition and image PicUrl", () => {
    const voice = parseWechatXml(
      "<xml><ToUserName><![CDATA[a]]></ToUserName><FromUserName><![CDATA[b]]></FromUserName>" +
        "<MsgType><![CDATA[voice]]></MsgType><MediaId><![CDATA[m1]]></MediaId><Format><![CDATA[amr]]></Format>" +
        "<Recognition><![CDATA[今天买牛奶]]></Recognition></xml>"
    );
    expect(voice).toMatchObject({ msgType: "voice", mediaId: "m1", recognition: "今天买牛奶" });
    const image = parseWechatXml(
      "<xml><ToUserName><![CDATA[a]]></ToUserName><FromUserName><![CDATA[b]]></FromUserName>" +
        "<MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://mmbiz.qpic.cn/x.jpg]]></PicUrl></xml>"
    );
    expect(image).toMatchObject({ msgType: "image", picUrl: "http://mmbiz.qpic.cn/x.jpg" });
  });

  it("returns null on malformed xml", () => {
    expect(parseWechatXml("<xml><MsgType>text</MsgType></xml>")).toBeNull();
  });

  it("buildTextReply emits the passive-reply shape", () => {
    const xml = buildTextReply("openid1", "gh_acct", "已存 ✓");
    expect(xml).toContain("<ToUserName><![CDATA[openid1]]></ToUserName>");
    expect(xml).toContain("<FromUserName><![CDATA[gh_acct]]></FromUserName>");
    expect(xml).toContain("<Content><![CDATA[已存 ✓]]></Content>");
  });
});

describe("extractBindCode", () => {
  it("accepts bare and prefixed codes", () => {
    expect(extractBindCode("123456")).toBe("123456");
    expect(extractBindCode(" 绑定 654321 ")).toBe("654321");
    expect(extractBindCode("bind 111222")).toBe("111222");
  });
  it("rejects everything else", () => {
    expect(extractBindCode("12345")).toBeNull();
    expect(extractBindCode("1234567")).toBeNull();
    expect(extractBindCode("买牛奶 123456 记一下")).toBeNull();
  });
});

// ---- endpoint behavior with a stateful fake D1 ----

function fakeDb(state: { bindings: Map<string, string>; codes: Map<string, { user_id: string; expires_at: string }>; notes: { user_id: string; content: string; source: string }[] }) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM wechat_mp_bindings")) {
            const uid = state.bindings.get(binds[0] as string);
            return uid ? { user_id: uid } : null;
          }
          if (sql.includes("FROM wechat_mp_bind_codes")) {
            const row = state.codes.get(binds[0] as string);
            return row ? { user_id: row.user_id } : null;
          }
          if (sql.includes("FROM notes")) {
            const n = state.notes[state.notes.length - 1];
            return n
              ? { id: "n1", user_id: n.user_id, source: n.source, raw_type: "text", content: n.content, tags: "[]", meta: null, is_sensitive: 0, content_enc: null, category: null, url: null }
              : null;
          }
          if (sql.includes("FROM users")) return null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO notes")) {
            state.notes.push({ user_id: binds[1] as string, content: binds[4] as string, source: binds[2] as string });
          }
          if (sql.startsWith("INSERT INTO wechat_mp_bindings")) {
            state.bindings.set(binds[0] as string, binds[1] as string);
          }
          if (sql.startsWith("DELETE FROM wechat_mp_bind_codes WHERE code")) {
            state.codes.delete(binds[0] as string);
          }
          if (sql.startsWith("DELETE FROM wechat_mp_bindings WHERE openid")) {
            state.bindings.delete(binds[0] as string);
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(state: Parameters<typeof fakeDb>[0], extra: Record<string, string> = {}) {
  return {
    DB: fakeDb(state),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    AI_MODEL: "mock",
    WECHAT_MP_TOKEN: TOKEN,
    ...extra,
  };
}

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function textXml(openid: string, content: string): string {
  return (
    `<xml><ToUserName><![CDATA[gh_acct]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName>` +
    `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`
  );
}

async function postMp(env: object, xml: string): Promise<Response> {
  const ts = "111";
  const nonce = "222";
  const sig = await sign([TOKEN, ts, nonce]);
  return app.request(
    `/wechat/mp?signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
    { method: "POST", body: xml, headers: { "content-type": "application/xml" } },
    env,
    execCtx
  );
}

describe("/wechat/mp endpoint", () => {
  const freshState = () => ({ bindings: new Map<string, string>(), codes: new Map<string, { user_id: string; expires_at: string }>(), notes: [] as { user_id: string; content: string; source: string }[] });

  it("is 404 when WECHAT_MP_TOKEN is unset (feature off by default)", async () => {
    const env = { DB: fakeDb(freshState()), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
    expect((await app.request("/wechat/mp?echostr=x", {}, env, execCtx)).status).toBe(404);
    expect((await app.request("/wechat/mp", { method: "POST", body: "<xml/>" }, env, execCtx)).status).toBe(404);
  });

  it("GET echoes echostr only with a valid signature", async () => {
    const env = makeEnv(freshState());
    const ts = "111", nonce = "222";
    const sig = await sign([TOKEN, ts, nonce]);
    const ok = await app.request(`/wechat/mp?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=hello`, {}, env, execCtx);
    expect(await ok.text()).toBe("hello");
    const bad = await app.request(`/wechat/mp?signature=bad&timestamp=${ts}&nonce=${nonce}&echostr=hello`, {}, env, execCtx);
    expect(bad.status).toBe(403);
  });

  it("unbound openid gets binding instructions; valid code binds; then text ingests", async () => {
    const state = freshState();
    state.codes.set("123456", { user_id: "u_qa", expires_at: "2099-01-01 00:00:00" });
    const env = makeEnv(state);

    const r1 = await postMp(env, textXml("openidA", "随便说点什么"));
    expect(await r1.text()).toContain("绑定码");

    const r2 = await postMp(env, textXml("openidA", "绑定 123456"));
    expect(await r2.text()).toContain("绑定成功");
    expect(state.bindings.get("openidA")).toBe("u_qa");

    const r3 = await postMp(env, textXml("openidA", "买牛奶 #生活"));
    expect(await r3.text()).toContain("已存");
    expect(state.notes.length).toBe(1);
    expect(state.notes[0]).toMatchObject({ user_id: "u_qa", source: "wechat" });
  });

  it("invalid code is rejected; 解绑 removes the binding", async () => {
    const state = freshState();
    state.bindings.set("openidB", "u_qa");
    const env = makeEnv(state);

    const r1 = await postMp(env, textXml("openidB", "解绑"));
    expect(await r1.text()).toContain("已解绑");
    expect(state.bindings.has("openidB")).toBe(false);

    const r2 = await postMp(env, textXml("openidB", "999999"));
    expect(await r2.text()).toContain("无效或已过期");
  });

  it("safe (aes) mode decrypts incoming and encrypts the reply", async () => {
    const state = freshState();
    state.bindings.set("openidC", "u_qa");
    const env = makeEnv(state, { WECHAT_MP_AES_KEY: AES_KEY, WECHAT_MP_APPID: APPID });

    const inner = textXml("openidC", "加密通道测试");
    const enc = await encryptWechatMessage(AES_KEY, inner, APPID);
    const ts = "111", nonce = "222";
    const msgSig = await sign([TOKEN, ts, nonce, enc!]);
    const sig = await sign([TOKEN, ts, nonce]);
    const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
    const res = await app.request(
      `/wechat/mp?signature=${sig}&timestamp=${ts}&nonce=${nonce}&encrypt_type=aes&msg_signature=${msgSig}`,
      { method: "POST", body, headers: { "content-type": "application/xml" } },
      env,
      execCtx
    );
    const out = await res.text();
    expect(out).toContain("<Encrypt>");
    const outEnc = out.match(/<Encrypt><!\[CDATA\[(.+?)\]\]><\/Encrypt>/)![1];
    const decrypted = await decryptWechatMessage(AES_KEY, outEnc, APPID);
    expect(decrypted).toContain("已存");
    expect(state.notes.length).toBe(1);
  });

  it("? questions get the web hint instead of being stored", async () => {
    const state = freshState();
    state.bindings.set("openidD", "u_qa");
    const env = makeEnv(state);
    const res = await postMp(env, textXml("openidD", "？我最近在想什么"));
    expect(await res.text()).toContain("问一问");
    expect(state.notes.length).toBe(0);
  });
});
