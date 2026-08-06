import { describe, it, expect } from "vitest";
import { app } from "../src/index";

// Minimal fake D1 with one valid user token and empty data.
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
