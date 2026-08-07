import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { SENSITIVE_EXPORT_PLACEHOLDER } from "../src/constants";

const BASE_NOTE = {
  id: "n1",
  user_id: "u1",
  source: "api",
  raw_type: "text",
  category: "idea",
  tags: "[]",
  title: null,
  url: null,
  url_title: null,
  url_titles: null,
  meta: null,
  is_sensitive: 0,
  todo_due: null,
  todo_done: 0,
  thread_id: null,
  content_enc: null,
  created_at: "2026-08-07 00:00:00",
  updated_at: "2026-08-07 00:00:00",
};

// Minimal fake D1 with one valid user token and the given notes.
function fakeDb(notes: Record<string, unknown>[] = []) {
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
          if (sql.includes("FROM notes")) return { results: notes };
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

describe("GET /api/export format handling", () => {
  it("format=markdown returns markdown", async () => {
    const res = await app.request("/api/export?format=markdown", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("# 碎念全量导出");
  });

  it("format=md is an alias for markdown", async () => {
    const res = await app.request("/api/export?format=md", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("suinian-export.md");
    expect(await res.text()).toContain("# 碎念全量导出");
  });

  it("no format returns JSON", async () => {
    const res = await app.request("/api/export", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { notes: unknown[] };
    expect(Array.isArray(body.notes)).toBe(true);
  });
});

describe("GET /api/export sensitive-note redaction", () => {
  const sensitiveNote = { ...BASE_NOTE, is_sensitive: 1, content: "root 密码是 hunter2", category: "data" };
  const plainNote = { ...BASE_NOTE, id: "n2", content: "普通想法" };
  const senv = { ...env, DB: fakeDb([sensitiveNote, plainNote]) };

  it("redacts sensitive note content in JSON by default", async () => {
    const res = await app.request("/api/export", { headers: auth }, senv);
    const body = (await res.json()) as { notes: { id: string; content: string; is_sensitive: boolean }[] };
    const sens = body.notes.find((n) => n.id === "n1")!;
    expect(sens.content).toBe(SENSITIVE_EXPORT_PLACEHOLDER);
    expect(sens.is_sensitive).toBe(true);
    expect(body.notes.find((n) => n.id === "n2")!.content).toBe("普通想法");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("redacts sensitive note content in Markdown by default", async () => {
    const res = await app.request("/api/export?format=md", { headers: auth }, senv);
    const md = await res.text();
    expect(md).toContain(SENSITIVE_EXPORT_PLACEHOLDER);
    expect(md).not.toContain("hunter2");
    expect(md).toContain("普通想法");
  });

  it("exports plaintext when include_sensitive=true", async () => {
    const res = await app.request("/api/export?include_sensitive=true", { headers: auth }, senv);
    const body = (await res.json()) as { notes: { id: string; content: string }[] };
    expect(body.notes.find((n) => n.id === "n1")!.content).toBe("root 密码是 hunter2");
  });

  it("only exact 'true' enables plaintext export", async () => {
    const res = await app.request("/api/export?include_sensitive=1", { headers: auth }, senv);
    const body = (await res.json()) as { notes: { id: string; content: string }[] };
    expect(body.notes.find((n) => n.id === "n1")!.content).toBe(SENSITIVE_EXPORT_PLACEHOLDER);
  });
});
