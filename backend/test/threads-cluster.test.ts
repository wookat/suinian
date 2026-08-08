import { describe, it, expect } from "vitest";
import { clusterNote, rebuildThreads } from "../src/threads";
import type { Env, NoteRow } from "../src/types";

// In-memory fake D1 covering the SQL used by threads.ts
function fakeDb() {
  const notes = new Map<string, NoteRow>();
  const embeddings = new Map<string, string>();
  const threads = new Map<string, { id: string; user_id: string; title: string; note_count: number }>();

  function threadNoteCount(threadId: string): number {
    let c = 0;
    for (const n of notes.values()) if (n.thread_id === threadId) c++;
    return c;
  }

  const db = {
    notes,
    embeddings,
    threads,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("COUNT(*) AS c FROM threads")) {
            let c = 0;
            for (const t of threads.values()) if (t.user_id === binds[0] && t.note_count > 0) c++;
            return { c };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM notes n")) {
            // candidate ideas with embeddings
            const rows = [...notes.values()]
              .filter((n) => n.user_id === binds[0] && n.category === "idea" && n.id !== binds[1])
              .map((n) => ({
                id: n.id,
                thread_id: n.thread_id,
                title: n.title,
                content: n.content,
                vector: embeddings.get(n.id) ?? null,
              }));
            return { results: rows };
          }
          if (sql.includes("FROM threads WHERE user_id")) {
            return { results: [...threads.values()].filter((t) => t.user_id === binds[0]) };
          }
          if (sql.includes("thread_id IS NULL")) {
            const rows = [...notes.values()]
              .filter(
                (n) => n.user_id === binds[0] && n.category === "idea" && n.thread_id === null && n.id !== binds[1]
              )
              .map((n) => ({ id: n.id, title: n.title, content: n.content }));
            return { results: rows };
          }
          if (sql.includes("SELECT * FROM notes WHERE user_id")) {
            const rows = [...notes.values()].filter((n) => n.user_id === binds[0] && n.category === "idea");
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT OR REPLACE INTO note_embeddings")) {
            embeddings.set(binds[0] as string, binds[1] as string);
          } else if (sql.includes("INSERT INTO threads")) {
            threads.set(binds[0] as string, {
              id: binds[0] as string,
              user_id: binds[1] as string,
              title: binds[2] as string,
              note_count: 0,
            });
          } else if (sql.includes("UPDATE notes SET thread_id = ?")) {
            const n = notes.get(binds[1] as string);
            if (n) n.thread_id = binds[0] as string;
          } else if (sql.includes("UPDATE notes SET thread_id = NULL")) {
            for (const n of notes.values()) if (n.user_id === binds[0] && n.category === "idea") n.thread_id = null;
          } else if (sql.includes("UPDATE threads SET note_count")) {
            const t = threads.get(binds[1] as string);
            if (t) t.note_count = threadNoteCount(binds[0] as string);
          } else if (sql.includes("DELETE FROM threads WHERE user_id")) {
            const referenced = new Set([...notes.values()].map((n) => n.thread_id).filter(Boolean));
            for (const [id, t] of threads) if (t.user_id === binds[0] && !referenced.has(id)) threads.delete(id);
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

function makeNote(id: string, content: string, extra: Partial<NoteRow> = {}): NoteRow {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    content,
    url: null,
    url_title: null,
    url_summary: null,
    url_titles: null,
    category: "idea",
    tags: "[]",
    title: null,
    thread_id: null,
    is_sensitive: 0,
    content_enc: null,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    amount: null,
    currency: null,
    meta: null,
    created_at: "2026-08-01 00:00:00",
    updated_at: "2026-08-01 00:00:00",
    deleted_at: null,
    ...extra,
  };
}

// AI stub with per-content fixed vectors
function fakeAi(vectors: Record<string, number[]>) {
  return {
    async run(_model: string, input: { text: string[] }) {
      const key = Object.keys(vectors).find((k) => input.text[0].includes(k));
      return { data: key ? [vectors[key]] : [] };
    },
  };
}

function makeEnv(db: ReturnType<typeof fakeDb>, ai: unknown, deepseekAnswer?: string): Env {
  if (deepseekAnswer !== undefined) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: deepseekAnswer } }] }), {
        status: 200,
      })) as typeof fetch;
  }
  return {
    DB: db as unknown as D1Database,
    AI: ai as Ai | undefined,
    DEEPSEEK_API_KEY: deepseekAnswer !== undefined ? "test-key" : "",
    DEEPSEEK_BASE_URL: "https://example.invalid",
  } as Env;
}

describe("clusterNote cold start (no threads exist yet)", () => {
  it("creates the first thread when two ideas are highly similar (embedding path)", async () => {
    const db = fakeDb();
    const a = makeNote("a", "做一个 AI 收件箱");
    const b = makeNote("b", "AI 收件箱要支持微信");
    db.notes.set("a", a);
    db.notes.set("b", b);
    const ai = fakeAi({ "做一个 AI 收件箱": [1, 0, 0], "AI 收件箱要支持微信": [0.99, 0.1, 0] });
    const env = makeEnv(db, ai);
    await clusterNote(env, a); // no candidates with vectors yet
    await clusterNote(env, b); // should pair with a and create the first thread
    expect(db.threads.size).toBe(1);
    const threadId = [...db.threads.keys()][0];
    expect(db.notes.get("a")!.thread_id).toBe(threadId);
    expect(db.notes.get("b")!.thread_id).toBe(threadId);
  });

  it("creates the first thread via DeepSeek pairing when embeddings unavailable", async () => {
    const db = fakeDb();
    const a = makeNote("a", "做一个 AI 收件箱");
    const b = makeNote("b", "AI 收件箱要支持微信");
    db.notes.set("a", a);
    db.notes.set("b", b);
    const env = makeEnv(db, undefined, "1"); // DeepSeek: pick note #1
    await clusterNote(env, b);
    expect(db.threads.size).toBe(1);
    const threadId = [...db.threads.keys()][0];
    expect(db.notes.get("a")!.thread_id).toBe(threadId);
    expect(db.notes.get("b")!.thread_id).toBe(threadId);
  });

  it("confirms a borderline embedding match via DeepSeek", async () => {
    const db = fakeDb();
    const a = makeNote("a", "做一个 AI 收件箱");
    const b = makeNote("b", "AI 收件箱要支持微信");
    db.notes.set("a", a);
    db.notes.set("b", b);
    // cosine ≈ 0.6: candidate band, needs DeepSeek confirmation
    const ai = fakeAi({ "做一个 AI 收件箱": [1, 0, 0], "AI 收件箱要支持微信": [0.6, 0.8, 0] });
    const env = makeEnv(db, ai, "1");
    await clusterNote(env, a);
    await clusterNote(env, b);
    expect(db.threads.size).toBe(1);
  });

  it("does not merge dissimilar ideas", async () => {
    const db = fakeDb();
    const a = makeNote("a", "做一个 AI 收件箱");
    const b = makeNote("b", "今晚吃什么");
    db.notes.set("a", a);
    db.notes.set("b", b);
    const ai = fakeAi({ "做一个 AI 收件箱": [1, 0, 0], 今晚吃什么: [0, 1, 0] });
    const env = makeEnv(db, ai, "0");
    await clusterNote(env, a);
    await clusterNote(env, b);
    expect(db.threads.size).toBe(0);
    expect(db.notes.get("b")!.thread_id).toBeNull();
  });
});

describe("clusterNote merge into existing thread", () => {
  it("attaches a similar new idea to the matched note's thread (embedding path)", async () => {
    const db = fakeDb();
    db.threads.set("t1", { id: "t1", user_id: "u1", title: "AI 收件箱", note_count: 1 });
    const a = makeNote("a", "做一个 AI 收件箱", { thread_id: "t1" });
    const b = makeNote("b", "AI 收件箱要支持微信");
    db.notes.set("a", a);
    db.notes.set("b", b);
    db.embeddings.set("a", JSON.stringify([1, 0, 0]));
    const ai = fakeAi({ "AI 收件箱要支持微信": [0.99, 0.1, 0] });
    const env = makeEnv(db, ai);
    await clusterNote(env, b);
    expect(db.notes.get("b")!.thread_id).toBe("t1");
    expect(db.threads.get("t1")!.note_count).toBe(2);
  });

  it("attaches via DeepSeek thread pick when embeddings unavailable", async () => {
    const db = fakeDb();
    db.threads.set("t1", { id: "t1", user_id: "u1", title: "AI 收件箱", note_count: 1 });
    const a = makeNote("a", "做一个 AI 收件箱", { thread_id: "t1" });
    const b = makeNote("b", "AI 收件箱要支持微信");
    db.notes.set("a", a);
    db.notes.set("b", b);
    const env = makeEnv(db, undefined, "1");
    await clusterNote(env, b);
    expect(db.notes.get("b")!.thread_id).toBe("t1");
  });

  it("ignores non-idea notes", async () => {
    const db = fakeDb();
    const t = makeNote("t", "买牛奶", { category: "todo" });
    db.notes.set("t", t);
    const env = makeEnv(db, fakeAi({ 买牛奶: [1, 0, 0] }));
    await clusterNote(env, t);
    expect(db.threads.size).toBe(0);
  });
});

describe("rebuildThreads", () => {
  it("re-clusters all recent ideas from scratch", async () => {
    const db = fakeDb();
    const a = makeNote("a", "做一个 AI 收件箱");
    const b = makeNote("b", "AI 收件箱要支持微信", { created_at: "2026-08-02 00:00:00" });
    const c = makeNote("c", "今晚吃什么", { created_at: "2026-08-03 00:00:00" });
    db.notes.set("a", a);
    db.notes.set("b", b);
    db.notes.set("c", c);
    const ai = fakeAi({
      "做一个 AI 收件箱": [1, 0, 0],
      "AI 收件箱要支持微信": [0.99, 0.1, 0],
      今晚吃什么: [0, 1, 0],
    });
    const env = makeEnv(db, ai, "0");
    const res = await rebuildThreads(env, "u1");
    expect(res.ideas).toBe(3);
    expect(res.threads).toBe(1);
    expect(db.notes.get("a")!.thread_id).toBe(db.notes.get("b")!.thread_id);
    expect(db.notes.get("c")!.thread_id).toBeNull();
  });
});
