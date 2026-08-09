import { describe, it, expect } from "vitest";
import { app, purgeAtOf, SOFT_DELETE_RETENTION_DAYS } from "../src/index";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

function baseNote(id: string, deletedAt: string | null): Row {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    category: "idea",
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
    content: `note ${id}`,
    content_enc: null,
    created_at: "2026-08-01 00:00:00",
    updated_at: "2026-08-01 00:00:00",
    deleted_at: deletedAt,
  };
}

/** Stateful fake D1 covering trash list / purge / restore SQL over an in-memory notes array. */
function fakeEnv(notes: Row[]) {
  const db = {
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
          if (sql.includes("FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC")) {
            const rows = notes
              .filter((n) => n.user_id === binds[0] && n.deleted_at !== null)
              .sort((a, b) => ((a.deleted_at as string) < (b.deleted_at as string) ? 1 : -1));
            return { results: rows.map((n) => ({ ...n })) };
          }
          if (sql.includes("FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN")) {
            const ids = new Set(binds.slice(1) as string[]);
            return {
              results: notes
                .filter((n) => n.user_id === binds[0] && n.deleted_at !== null && ids.has(n.id as string))
                .map((n) => ({ id: n.id })),
            };
          }
          if (sql.includes("SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL")) {
            const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
            return {
              results: notes
                .filter((n) => n.user_id === binds[0] && n.deleted_at !== null)
                .slice(0, limit)
                .map((n) => ({ id: n.id })),
            };
          }
          if (sql.includes("FROM attachments")) return { results: [] };
          if (sql.includes("FROM edges")) return { results: [] };
          if (sql.includes("FROM threads")) return { results: [] };
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("DELETE FROM notes")) {
            const ids = new Set(binds as string[]);
            for (let i = notes.length - 1; i >= 0; i--) {
              if (ids.has(notes[i].id as string)) notes.splice(i, 1);
            }
            return { meta: { changes: ids.size } };
          }
          if (sql.startsWith("UPDATE notes SET deleted_at = NULL")) {
            const ids = new Set(binds.slice(1) as string[]);
            let changes = 0;
            for (const n of notes) {
              if (n.user_id === binds[0] && n.deleted_at !== null && ids.has(n.id as string)) {
                n.deleted_at = null;
                changes++;
              }
            }
            return { meta: { changes } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return { DB: db } as unknown as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(path: string, method = "GET", body?: unknown) {
  return new Request(`http://x${path}`, {
    method,
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("purgeAtOf", () => {
  it("adds the retention window to a stored UTC deleted_at", () => {
    expect(purgeAtOf("2026-08-01 12:00:00", 30)).toBe("2026-08-31 12:00:00");
  });

  it("defaults to the 30-day retention window", () => {
    expect(SOFT_DELETE_RETENTION_DAYS).toBe(30);
    expect(purgeAtOf("2026-08-01 00:00:00")).toBe("2026-08-31 00:00:00");
  });

  it("returns null on garbage timestamps", () => {
    expect(purgeAtOf("not-a-date")).toBeNull();
  });
});

describe("GET /api/notes/trash", () => {
  it("lists only soft-deleted notes, newest deletion first, with purge_at", async () => {
    const notes = [
      baseNote("n1", null),
      baseNote("n2", "2026-08-02 10:00:00"),
      baseNote("n3", "2026-08-05 10:00:00"),
    ];
    const res = await app.fetch(req("/api/notes/trash"), fakeEnv(notes), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: { id: string; purge_at: string }[]; retention_days: number };
    expect(body.retention_days).toBe(30);
    expect(body.notes.map((n) => n.id)).toEqual(["n3", "n2"]);
    expect(body.notes[0].purge_at).toBe("2026-09-04 10:00:00");
  });
});

describe("POST /api/notes/purge", () => {
  it("hard-deletes owned soft-deleted notes and skips live ones", async () => {
    const notes = [baseNote("n1", null), baseNote("n2", "2026-08-02 10:00:00")];
    const res = await app.fetch(req("/api/notes/purge", "POST", { ids: ["n1", "n2"] }), fakeEnv(notes), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purged: number };
    expect(body.purged).toBe(1);
    expect(notes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("rejects an empty id list", async () => {
    const res = await app.fetch(req("/api/notes/purge", "POST", { ids: [] }), fakeEnv([]), ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/notes/trash/empty", () => {
  it("purges every soft-deleted note and leaves live notes alone", async () => {
    const notes = [
      baseNote("n1", null),
      baseNote("n2", "2026-08-02 10:00:00"),
      baseNote("n3", "2026-08-03 10:00:00"),
    ];
    const res = await app.fetch(req("/api/notes/trash/empty", "POST", {}), fakeEnv(notes), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; purged: number };
    expect(body.purged).toBe(2);
    expect(notes.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("restore still works for trash items", () => {
  it("clears deleted_at via POST /api/notes/restore", async () => {
    const notes = [baseNote("n2", "2026-08-02 10:00:00")];
    const res = await app.fetch(req("/api/notes/restore", "POST", { ids: ["n2"] }), fakeEnv(notes), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: number };
    expect(body.restored).toBe(1);
    expect(notes[0].deleted_at).toBeNull();
  });
});
