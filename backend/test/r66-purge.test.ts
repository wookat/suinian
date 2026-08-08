import { describe, it, expect } from "vitest";
import { purgeExpiredSoftDeletes, resolveBatchFilter } from "../src/index";
import type { Env } from "../src/types";

type NoteRow = { id: string; user_id: string; deleted_at: string | null };

/**
 * Stateful fake D1 covering the SQL the purge sweep issues: the expired-notes
 * SELECT (ordered, limited), chunked IN deletes over derived tables and notes,
 * and the thread reconcile SELECT (returns no threads).
 */
function fakePurgeEnv(notes: NoteRow[], counters: { selects: number }) {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes("FROM notes WHERE deleted_at IS NOT NULL")) {
            counters.selects += 1;
            const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
            const rows = notes
              .filter((n) => n.deleted_at !== null)
              .sort((a, b) => (a.deleted_at! < b.deleted_at! ? -1 : 1))
              .slice(0, limit)
              .map((n) => ({ id: n.id, user_id: n.user_id }));
            return { results: rows };
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
              if (ids.has(notes[i].id)) notes.splice(i, 1);
            }
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return { DB: db } as unknown as Env;
}

const ctx = { waitUntil() {} } as unknown as ExecutionContext;

function expiredNotes(count: number): NoteRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    user_id: "u1",
    deleted_at: `2026-01-01 00:00:${String(i % 60).padStart(2, "0")}`,
  }));
}

describe("purgeExpiredSoftDeletes", () => {
  it("drains a multi-batch backlog in one run within the time budget", async () => {
    const notes = expiredNotes(450);
    const counters = { selects: 0 };
    const purged = await purgeExpiredSoftDeletes(fakePurgeEnv(notes, counters), ctx);
    expect(purged).toBe(450);
    expect(notes.length).toBe(0);
    // 200-per-batch: 3 selects (200 + 200 + 50)
    expect(counters.selects).toBe(3);
  });

  it("stops after the current batch when the time budget is exhausted", async () => {
    const notes = expiredNotes(450);
    const counters = { selects: 0 };
    const purged = await purgeExpiredSoftDeletes(fakePurgeEnv(notes, counters), ctx, 0);
    expect(purged).toBe(200);
    expect(notes.length).toBe(250);
    expect(counters.selects).toBe(1);
  });

  it("returns 0 and issues one select when there is no backlog", async () => {
    const notes: NoteRow[] = [];
    const counters = { selects: 0 };
    const purged = await purgeExpiredSoftDeletes(fakePurgeEnv(notes, counters), ctx);
    expect(purged).toBe(0);
    expect(counters.selects).toBe(1);
  });
});

describe("resolveBatchFilter", () => {
  it("reports total matches beyond the id cap", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind() {
              return stmt;
            },
            async first() {
              if (sql.includes("COUNT(*)")) return { n: 1200 };
              return null;
            },
            async all() {
              const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
              return { results: Array.from({ length: Math.min(limit, 1200) }, (_, i) => ({ id: `n${i}` })) };
            },
          };
          return stmt;
        },
      },
    } as unknown as Env;
    const { ids, total } = await resolveBatchFilter(env, "u1", {});
    expect(ids.length).toBe(1000);
    expect(total).toBe(1200);
  });
});
