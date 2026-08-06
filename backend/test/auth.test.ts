import { describe, it, expect } from "vitest";
import app from "../src/index";

// Minimal fake D1: one user with token "good-token", empty notes table.
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
          if (sql.includes("FROM users")) {
            return binds[0] === "good-token" ? { id: "u1" } : null;
          }
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

describe("bearer auth", () => {
  it("rejects missing token", async () => {
    const res = await app.request("/api/notes", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const res = await app.request("/api/notes", { headers: { authorization: "Bearer bad" } }, env);
    expect(res.status).toBe(401);
  });

  it("accepts valid token", async () => {
    const res = await app.request("/api/notes", { headers: { authorization: "Bearer good-token" } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: unknown[]; next_cursor: string | null };
    expect(body.notes).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("rejects invalid cursor with 400", async () => {
    const res = await app.request(
      "/api/notes?cursor=%21%21%21",
      { headers: { authorization: "Bearer good-token" } },
      env
    );
    expect(res.status).toBe(400);
  });

  it("health endpoint is public", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
  });
});
