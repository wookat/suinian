import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import { detectSensitive } from "../src/triage";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

type Row = Record<string, unknown>;

const BASE_NOTE: Row = {
  id: "n1",
  user_id: "u1",
  source: "api",
  raw_type: "text",
  category: "data",
  tags: "[]",
  title: null,
  url: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  meta: null,
  is_sensitive: 0,
  todo_due: null,
  todo_done: 0,
  thread_id: null,
  content: "hello world",
  content_enc: null,
  created_at: "2026-08-07 00:00:00",
  updated_at: "2026-08-07 00:00:00",
};

// Stateful fake D1: applies UPDATE notes SET ... back onto the row.
function fakeDb(note: Row) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("auth_rate_limits")) return { count: 1 };
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("FROM notes")) return { ...note };
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            cols.forEach((col, i) => {
              note[col] = binds[i];
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(note: Row) {
  return {
    DB: fakeDb(note),
    SUINIAN_ENC_KEY: KEY,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function patch(body: Record<string, unknown>) {
  return new Request("http://x/api/notes/n1", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/notes/:id is_sensitive toggle", () => {
  it("marking sensitive encrypts content at rest", async () => {
    const note: Row = { ...BASE_NOTE };
    const env = makeEnv(note);
    const res = await app.request(patch({ is_sensitive: true }), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(note.is_sensitive).toBe(1);
    expect(note.content).toBe(ENC_PLACEHOLDER);
    expect(await decryptContent(KEY, note.content_enc as string)).toBe("hello world");
    // response still returns decrypted plaintext
    const body = (await res.json()) as { note: { content: string; is_sensitive: boolean } };
    expect(body.note.content).toBe("hello world");
    expect(body.note.is_sensitive).toBe(true);
  });

  it("unmarking sensitive restores plaintext and clears ciphertext", async () => {
    const enc = await encryptContent(KEY, "top secret pw");
    const note: Row = { ...BASE_NOTE, is_sensitive: 1, content: ENC_PLACEHOLDER, content_enc: enc };
    const env = makeEnv(note);
    const res = await app.request(patch({ is_sensitive: false }), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(note.is_sensitive).toBe(0);
    expect(note.content).toBe("top secret pw");
    expect(note.content_enc).toBeNull();
    const body = (await res.json()) as { note: { content: string; is_sensitive: boolean } };
    expect(body.note.content).toBe("top secret pw");
    expect(body.note.is_sensitive).toBe(false);
  });

  it("unmarking a legacy sensitive note without ciphertext keeps stored content", async () => {
    const note: Row = { ...BASE_NOTE, is_sensitive: 1, content: "plain legacy", content_enc: null };
    const env = makeEnv(note);
    const res = await app.request(patch({ is_sensitive: false }), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(note.content).toBe("plain legacy");
    expect(note.content_enc).toBeNull();
    expect(note.is_sensitive).toBe(0);
  });

  it("editing content on a sensitivity-toggled-on note encrypts the new content", async () => {
    const note: Row = { ...BASE_NOTE };
    const env = makeEnv(note);
    const res = await app.request(
      patch({ is_sensitive: true, content: "new secret" }),
      undefined,
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(note.content).toBe(ENC_PLACEHOLDER);
    expect(await decryptContent(KEY, note.content_enc as string)).toBe("new secret");
  });

  it("no-op body still rejects", async () => {
    const note: Row = { ...BASE_NOTE };
    const res = await app.request(patch({}), undefined, makeEnv(note), ctx);
    expect(res.status).toBe(400);
  });
});

describe("detectSensitive fallback precision", () => {
  it("flags real credential values", () => {
    expect(detectSensitive("服务器 root 密码是 P@ssw0rd123")).toBe(true);
    expect(detectSensitive("家里 Wi-Fi 密码改成了 hunter2-demo")).toBe(true);
    expect(detectSensitive("OpenAI key sk-abcdef1234567890abcdef")).toBe(true);
    expect(detectSensitive("银行卡号 6222020200112233445")).toBe(true);
  });

  it("does not flag technical docs / code that only mention credential concepts", () => {
    expect(detectSensitive("JWT token 的刷新机制：access token 短效期，refresh token 长效期")).toBe(false);
    expect(detectSensitive("配置 API key 的步骤：在控制台生成 key 后写入环境变量")).toBe(false);
    expect(detectSensitive('curl -H "Authorization: Bearer <token>" 调用接口')).toBe(false);
    expect(detectSensitive("重置密码的流程：点击忘记密码，输入邮箱收验证码")).toBe(false);
    expect(detectSensitive("commit 哈希 3f9a2b7c8d1e0f4a5b6c7d8e9f0a1b2c 触发了构建")).toBe(false);
  });

  it("does not flag placeholder values", () => {
    expect(detectSensitive("密码：<你的密码>")).toBe(false);
    expect(detectSensitive("password: your-password-here")).toBe(false);
  });
});
