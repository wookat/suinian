import { describe, it, expect } from "vitest";
import { generateDailyReview, generateAllDailyReviews } from "../src/review";
import type { Env, NoteRow } from "../src/types";

function makeNote(id: string, content: string): NoteRow {
  return {
    id,
    user_id: "u1",
    source: "web",
    raw_type: "text",
    content,
    url: null,
    title: null,
    category: "idea",
    tags: "[]",
    due_at: null,
    is_sensitive: 0,
    meta: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
  } as unknown as NoteRow;
}

/**
 * Fake D1 for the daily-review pipeline. Strict candidate queries
 * (anniversary / revisit) return nothing so the relaxed fallback is
 * exercised; the relaxed query returns `relaxedNotes`.
 */
function fakeEnv(opts: { users: string[]; relaxedNotes: NoteRow[] }) {
  const inserted: unknown[][] = [];
  const DB = {
    inserted,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("COUNT(*) AS n FROM daily_reviews")) {
            const n = inserted.filter((b) => b[1] === binds[0] && b[2] === binds[1]).length;
            return { n };
          }
          return null;
        },
        async all() {
          if (sql.startsWith("SELECT id FROM users")) {
            return { results: opts.users.map((id) => ({ id })) };
          }
          if (sql.includes("created_at < datetime('now', '-1 day')")) {
            return { results: opts.relaxedNotes.slice(0, binds[binds.length - 1] as number) };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO daily_reviews")) inserted.push(binds);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB, DEEPSEEK_API_KEY: "" } as unknown as Env, inserted };
}

describe("generateDailyReview", () => {
  it("falls back to relaxed candidates and persists rows", async () => {
    const { env, inserted } = fakeEnv({ users: ["u1"], relaxedNotes: [makeNote("n1", "一条足够长的旧笔记内容")] });
    const n = await generateDailyReview(env, "u1");
    expect(n).toBe(1);
    expect(inserted.length).toBe(1);
    expect(inserted[0][3]).toBe("n1"); // note_id
    expect(inserted[0][4]).toBe("revisit"); // kind
  });

  it("returns 0 without persisting when there is truly no material", async () => {
    const { env, inserted } = fakeEnv({ users: ["u1"], relaxedNotes: [] });
    expect(await generateDailyReview(env, "u1")).toBe(0);
    expect(inserted.length).toBe(0);
  });

  it("is idempotent for the same date", async () => {
    const { env, inserted } = fakeEnv({ users: ["u1"], relaxedNotes: [makeNote("n1", "一条足够长的旧笔记内容")] });
    await generateDailyReview(env, "u1");
    await generateDailyReview(env, "u1");
    expect(inserted.length).toBe(1);
  });
});

describe("generateAllDailyReviews", () => {
  it("returns sweep stats and counts empty users", async () => {
    const { env } = fakeEnv({ users: ["u1", "u2"], relaxedNotes: [] });
    const stats = await generateAllDailyReviews(env);
    expect(stats).toEqual({ users: 2, generated: 0, already: 0, empty: 2, failed: 0 });
  });

  it("counts users whose reviews already exist as already, and writes a heartbeat", async () => {
    const { env, inserted } = fakeEnv({ users: ["u1"], relaxedNotes: [makeNote("n1", "一条足够长的旧笔记内容")] });
    expect(await generateAllDailyReviews(env)).toMatchObject({ generated: 1, already: 0 });
    expect(await generateAllDailyReviews(env)).toMatchObject({ generated: 0, already: 1 });
    expect(inserted.length).toBe(1);
  });
});
