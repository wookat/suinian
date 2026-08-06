import { describe, it, expect } from "vitest";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import { extractUrls } from "../src/linkmeta";
import { app } from "../src/index";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
// 32-byte keys, base64
const KEY = b64(new Uint8Array(32));
const KEY2 = b64(new Uint8Array(32).fill(1));

describe("AES-GCM content encryption", () => {
  it("round-trips Chinese + secret content", async () => {
    const plain = "服务器密码是 Hunter2！中文内容 🔐";
    const enc = await encryptContent(KEY, plain);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("Hunter2");
    expect(await decryptContent(KEY, enc)).toBe(plain);
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", async () => {
    const a = await encryptContent(KEY, "same");
    const b = await encryptContent(KEY, "same");
    expect(a).not.toBe(b);
  });

  it("returns null on wrong key or malformed input", async () => {
    const enc = await encryptContent(KEY, "secret");
    expect(await decryptContent(KEY2, enc)).toBeNull();
    expect(await decryptContent(KEY, "garbage")).toBeNull();
    expect(await decryptContent(KEY, "v1:notbase64")).toBeNull();
  });

  it("placeholder is the masked marker", () => {
    expect(ENC_PLACEHOLDER).toBe("[加密内容]");
  });
});

describe("extractUrls (multi-link)", () => {
  it("extracts up to 3 distinct urls in order", () => {
    const text =
      "看这三个：https://a.example.com/1 还有 https://b.example.com/2，以及 https://c.example.com/3 和 https://d.example.com/4";
    expect(extractUrls(text, 3)).toEqual([
      "https://a.example.com/1",
      "https://b.example.com/2",
      "https://c.example.com/3",
    ]);
  });

  it("dedupes repeated urls", () => {
    expect(extractUrls("https://x.com/a 再看一遍 https://x.com/a", 3)).toEqual(["https://x.com/a"]);
  });

  it("returns empty array when no url", () => {
    expect(extractUrls("没有链接的普通笔记", 3)).toEqual([]);
  });
});

// Minimal fake D1 with one valid user token.
function fakeDb() {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const env = { DB: fakeDb(), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
const auth = { authorization: "Bearer good-token" };

describe("20k content limit", () => {
  const long = "字".repeat(20_001);

  it("POST /api/notes returns 413 with a human message", async () => {
    const res = await app.request(
      "/api/notes",
      { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ content: long }) },
      env
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("内容过长");
    expect(body.error).toContain("20000");
  });

  it("POST /api/ingest/wechat returns 413", async () => {
    const res = await app.request(
      "/api/ingest/wechat",
      { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ content: long }) },
      env
    );
    expect(res.status).toBe(413);
  });

  it("accepts exactly 20000 chars", async () => {
    const res = await app.request(
      "/api/notes",
      {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ content: "字".repeat(20_000) }),
      },
      env,
      { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    );
    expect(res.status).not.toBe(413);
  });
});

describe("JSON 404s", () => {
  it("GET /api/threads/:id unknown id → JSON 404", async () => {
    const res = await app.request("/api/threads/nonexistent", { headers: auth }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: string }).error).toBe("not found");
  });

  it("GET /api/reports/:id unknown id → JSON 404", async () => {
    const res = await app.request("/api/reports/nonexistent", { headers: auth }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("unknown route → JSON 404 (not plain text)", async () => {
    const res = await app.request("/api/threadsx", { headers: auth }, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
