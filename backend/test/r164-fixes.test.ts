import { describe, it, expect, vi } from "vitest";
import type { Env, NoteRow } from "../src/types";
import {
  noteHasSemanticSignal,
  noteSemanticSource,
  ensureNoteEmbedding,
  purgeLowSignalEmbeddings,
} from "../src/semantic";
import { detachZeroSignalThreadMembers } from "../src/threads";
import { app, noteFilterConds } from "../src/index";
import { dedupeNotesByContent } from "../src/ask";
import { hashPassword } from "../src/auth";
import { generateDailyReview } from "../src/review";

// ---- P1-1: the semantic gate must judge the user-original text, never the
// AI triage title (audit-r163: 「庆祝」 titles resurrected emoji vectors) ----

const N = (id: string, content: string, over: Partial<NoteRow> = {}): Partial<NoteRow> => ({
  id,
  user_id: "u1",
  content,
  title: null,
  url_title: null,
  url_summary: null,
  is_sensitive: 0,
  thread_id: null,
  ...over,
});

describe("R164 P1-1 noteHasSemanticSignal", () => {
  it("rejects an emoji-only note even when triage gave it a text title", () => {
    expect(noteHasSemanticSignal({ content: "🎉🎉🎉", url_title: null, url_summary: null })).toBe(false);
    // the AI title never enters the judged text
    expect(noteSemanticSource({ content: "🎉🎉🎉", url_title: null, url_summary: null })).toBe("🎉🎉🎉");
  });

  it("keeps notes whose user-original text has signal", () => {
    expect(noteHasSemanticSignal({ content: "买咖啡豆", url_title: null, url_summary: null })).toBe(true);
  });

  it("counts text derived from a user-supplied URL as user-original signal", () => {
    expect(noteHasSemanticSignal({ content: "😀", url_title: "Coffee guide", url_summary: null })).toBe(true);
    expect(noteHasSemanticSignal({ content: "😀", url_title: null, url_summary: "手冲咖啡入门" })).toBe(true);
  });
});

describe("R164 P1-1 ensureNoteEmbedding gate", () => {
  function fakeEnv() {
    const inserted: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async run() {
            if (sql.startsWith("INSERT OR REPLACE INTO note_embeddings")) inserted.push(binds);
            return { meta: { changes: 1 } };
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
        };
        return stmt;
      },
    };
    const run = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    const env = { DB: db, AI: { run }, VECTORIZE: undefined } as unknown as Env;
    return { env, inserted, run };
  }

  it("writes the '[]' sentinel and never embeds a titled pure-emoji note", async () => {
    const { env, inserted, run } = fakeEnv();
    const note = N("e1", "🎉🎉🎉", { title: "庆祝" }) as NoteRow;
    const v = await ensureNoteEmbedding(env, note, { refresh: true });
    expect(v).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(["e1"]); // sentinel insert binds only the id
    expect(run).not.toHaveBeenCalled();
  });

  it("still embeds a note with real user text and a title", async () => {
    const { env, inserted, run } = fakeEnv();
    const note = N("e2", "学做糖醋排骨", { title: "做菜心得" }) as NoteRow;
    const v = await ensureNoteEmbedding(env, note, { refresh: true });
    expect(v).toEqual([0.1, 0.2]);
    expect(inserted).toHaveLength(1);
    expect(run).toHaveBeenCalled();
  });
});

// ---- stock cleanup: purge titled-emoji vectors + detach thread members ----

type EmbeddingRow = { note_id: string; vector: string };

function purgeEnv(notes: Partial<NoteRow>[], embeddings: EmbeddingRow[]) {
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
          if (sql.includes("JOIN note_embeddings e")) {
            const limit = binds[0] as number;
            const offset = binds[1] as number;
            const rows = notes
              .filter((n) => {
                const e = embeddings.find((e) => e.note_id === n.id);
                return e && e.vector !== "[]" && !n.is_sensitive;
              })
              .slice(offset, offset + limit);
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE note_embeddings SET vector = '[]'")) {
            const e = embeddings.find((e) => e.note_id === binds[0]);
            if (e) e.vector = "[]";
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db, VECTORIZE: undefined } as unknown as Env, embeddings };
}

describe("R164 P1-1 purgeLowSignalEmbeddings judges the user-original text", () => {
  it("purges the vector of a titled pure-emoji note", async () => {
    const notes = [
      N("good", "买咖啡豆", { title: "咖啡" }),
      N("bad", "🎉🎉🎉", { title: "庆祝" }),
    ];
    const { env, embeddings } = purgeEnv(notes, [
      { note_id: "good", vector: "[0.1,0.2]" },
      { note_id: "bad", vector: "[0.3,0.4]" },
    ]);
    expect(await purgeLowSignalEmbeddings(env)).toBe(1);
    expect(embeddings.find((e) => e.note_id === "bad")?.vector).toBe("[]");
    expect(embeddings.find((e) => e.note_id === "good")?.vector).toBe("[0.1,0.2]");
  });
});

describe("R164 P1-1 detachZeroSignalThreadMembers", () => {
  function threadEnv(notes: Partial<NoteRow>[], threadCounts: Record<string, number>) {
    const detachedIds: string[] = [];
    const dissolvedThreads: string[] = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async first() {
            if (sql.includes("COUNT(*) AS c FROM notes WHERE thread_id")) {
              const tid = binds[0] as string;
              return { c: notes.filter((n) => n.thread_id === tid && !detachedIds.includes(n.id as string)).length };
            }
            return null;
          },
          async all() {
            if (sql.includes("WHERE thread_id IS NOT NULL")) {
              const limit = binds[0] as number;
              const offset = binds[1] as number;
              const rows = notes
                .filter((n) => n.thread_id && !detachedIds.includes(n.id as string))
                .slice(offset, offset + limit);
              return { results: rows };
            }
            if (sql.includes("SELECT title, content, created_at FROM notes")) {
              return { results: [] }; // summarize becomes a no-op
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("UPDATE notes SET thread_id = NULL, updated_at") && sql.includes("WHERE id = ?")) {
              detachedIds.push(binds[0] as string);
            }
            if (sql.startsWith("DELETE FROM threads")) dissolvedThreads.push(binds[0] as string);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const env = { DB: db, AI: undefined, VECTORIZE: undefined } as unknown as Env;
    return { env, detachedIds, dissolvedThreads, threadCounts };
  }

  it("detaches titled emoji members and keeps real members threaded", async () => {
    const notes = [
      N("m1", "咖啡烘焙记录一", { thread_id: "t1" }),
      N("m2", "咖啡烘焙记录二", { thread_id: "t1" }),
      N("m3", "🎉🎉🎉", { title: "庆祝", thread_id: "t1" }),
    ];
    const { env, detachedIds } = threadEnv(notes, { t1: 3 });
    expect(await detachZeroSignalThreadMembers(env)).toBe(1);
    expect(detachedIds).toEqual(["m3"]);
  });

  it("is idempotent", async () => {
    const notes = [
      N("m1", "咖啡烘焙记录一", { thread_id: "t1" }),
      N("m2", "咖啡烘焙记录二", { thread_id: "t1" }),
      N("m3", "😭😭 💪", { title: "当前情绪", thread_id: "t1" }),
    ];
    const { env } = threadEnv(notes, { t1: 3 });
    expect(await detachZeroSignalThreadMembers(env)).toBe(1);
    expect(await detachZeroSignalThreadMembers(env)).toBe(0);
  });
});

// ---- P2-1: exact-URL filter on GET /api/notes (extension clip dedupe) ----

describe("R164 P2-1 noteFilterConds url filter", () => {
  it("adds an exact url condition when url is a non-empty string", () => {
    const { conds, binds } = noteFilterConds({ url: "https://example.com/a" });
    expect(conds).toContain("url = ?");
    expect(binds).toContain("https://example.com/a");
  });

  it("ignores missing or non-string url", () => {
    expect(noteFilterConds({}).conds).not.toContain("url = ?");
    expect(noteFilterConds({ url: "" }).conds).not.toContain("url = ?");
    expect(noteFilterConds({ url: 42 }).conds).not.toContain("url = ?");
  });
});

// ---- 设计建议 3: Ask 引用按内容精确聚合 ----

describe("R164 design-3 dedupeNotesByContent", () => {
  it("keeps only the first of exact-content duplicates (whitespace-trimmed)", () => {
    const notes = [
      { id: "a", content: "同一段剪藏内容" },
      { id: "b", content: "  同一段剪藏内容  " },
      { id: "c", content: "另一条笔记" },
    ];
    expect(dedupeNotesByContent(notes).map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("leaves distinct contents untouched", () => {
    const notes = [
      { id: "a", content: "内容一" },
      { id: "b", content: "内容二" },
    ];
    expect(dedupeNotesByContent(notes)).toEqual(notes);
  });
});

// ---- 设计建议 2: include_sensitive=true 需要密码复核 ----

function exportEnv(passwordHash: string | null) {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("password_hash FROM users")) return { password_hash: passwordHash };
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("auth_rate_limits")) return { count: 1 };
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
  return { DB: db, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
}

describe("R164 design-2 sensitive export password re-verification", () => {
  const auth = { authorization: "Bearer good-token" };

  it("rejects include_sensitive=true without a password for password-backed accounts", async () => {
    const env = exportEnv(await hashPassword("secret-pw"));
    const res = await app.request("/api/export?include_sensitive=true", { headers: auth }, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { password_required?: boolean };
    expect(body.password_required).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const env = exportEnv(await hashPassword("secret-pw"));
    const res = await app.request(
      "/api/export?include_sensitive=true",
      { headers: { ...auth, "x-suinian-password": "wrong" } },
      env
    );
    expect(res.status).toBe(403);
  });

  it("allows a correct password (encodeURIComponent-encoded)", async () => {
    const env = exportEnv(await hashPassword("秘密 pw"));
    const res = await app.request(
      "/api/export?include_sensitive=true",
      { headers: { ...auth, "x-suinian-password": encodeURIComponent("秘密 pw") } },
      env
    );
    expect(res.status).toBe(200);
  });

  it("keeps legacy token-only accounts (no password_hash) working unchanged", async () => {
    const env = exportEnv(null);
    const res = await app.request("/api/export?include_sensitive=true", { headers: auth }, env);
    expect(res.status).toBe(200);
  });

  it("guards /api/backup the same way", async () => {
    const env = exportEnv(await hashPassword("secret-pw"));
    const res = await app.request("/api/backup?include_sensitive=true", { headers: auth }, env);
    expect(res.status).toBe(403);
  });
});

// ---- 跨日不复读：时间旅行两日生成，7 天冷却窗口内绝不复读同一笔记 ----

function reviewNote(id: string, content: string): NoteRow {
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
    is_sensitive: 0,
    meta: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
  } as unknown as NoteRow;
}

/**
 * Fake D1 that faithfully enforces the relaxed-candidate 7-day cooldown
 * subquery against rows inserted into daily_reviews, so time-travelling the
 * `now` argument across days exercises the real non-repetition contract.
 */
function multiDayEnv(pool: NoteRow[]) {
  const inserted: unknown[][] = []; // [id, user_id, review_date, note_id, kind, comment, position]
  const DB = {
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
          if (sql.includes("created_at < datetime('now', '-1 day')")) {
            // enforce: id NOT IN (recent daily_reviews within 7 days of real now)
            const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
            const recent = new Set(
              inserted.filter((b) => (b[2] as string) >= cutoff).map((b) => b[3] as string)
            );
            const limit = binds[binds.length - 1] as number;
            return { results: pool.filter((n) => !recent.has(n.id)).slice(0, limit) };
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

describe("R164 cross-day review non-repetition (time-travelled multi-day)", () => {
  it("never repeats a note across consecutive days within the cooldown", async () => {
    const { env, inserted } = multiDayEnv([
      reviewNote("d1", "第一条足够长的旧笔记内容"),
      reviewNote("d2", "第二条足够长的旧笔记内容"),
    ]);
    const day1 = new Date();
    const day2 = new Date(day1.getTime() + 86400_000);
    expect(await generateDailyReview(env, "u1", day1)).toBe(1);
    expect(await generateDailyReview(env, "u1", day2)).toBe(1);
    const dates = inserted.map((b) => b[2]);
    expect(new Set(dates).size).toBe(2); // two distinct review dates
    const noteIds = inserted.map((b) => b[3]);
    expect(new Set(noteIds).size).toBe(2); // no note repeated across days
  });

  it("prefers an empty day over repeating when the pool is exhausted", async () => {
    const { env, inserted } = multiDayEnv([reviewNote("only", "唯一一条足够长的旧笔记")]);
    const day1 = new Date();
    const day2 = new Date(day1.getTime() + 86400_000);
    const day3 = new Date(day1.getTime() + 2 * 86400_000);
    expect(await generateDailyReview(env, "u1", day1)).toBe(1);
    expect(await generateDailyReview(env, "u1", day2)).toBe(0);
    expect(await generateDailyReview(env, "u1", day3)).toBe(0);
    expect(inserted).toHaveLength(1);
  });
});
