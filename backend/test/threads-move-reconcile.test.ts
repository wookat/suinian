import { describe, it, expect } from "vitest";
import { clusterNote, reconcileThread } from "../src/threads";
import type { Env, NoteRow } from "../src/types";

// Stateful fake D1 covering the SQL used by clusterNote + reconcileThread,
// including the note-move path (a note leaving its previous thread).
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
          if (sql.includes("SELECT thread_id FROM notes WHERE id")) {
            const n = notes.get(binds[0] as string);
            return n ? { thread_id: n.thread_id } : null;
          }
          if (sql.includes("COUNT(*) AS c FROM notes WHERE thread_id")) {
            return { c: threadNoteCount(binds[0] as string) };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM notes n")) {
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
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT OR REPLACE INTO note_embeddings")) {
            embeddings.set(binds[0] as string, binds[1] as string);
          } else if (sql.includes("UPDATE notes SET thread_id = ?")) {
            const n = notes.get(binds[1] as string);
            if (n) n.thread_id = binds[0] as string;
          } else if (sql.includes("UPDATE notes SET thread_id = NULL, updated_at = datetime('now') WHERE thread_id")) {
            for (const n of notes.values()) if (n.thread_id === binds[0]) n.thread_id = null;
          } else if (sql.includes("UPDATE threads SET note_count = (SELECT COUNT(*)")) {
            const t = threads.get(binds[1] as string);
            if (t) t.note_count = threadNoteCount(binds[0] as string);
          } else if (sql.includes("UPDATE threads SET note_count = ?")) {
            const t = threads.get(binds[1] as string);
            if (t) t.note_count = binds[0] as number;
          } else if (sql.startsWith("DELETE FROM threads WHERE id")) {
            threads.delete(binds[0] as string);
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

function fakeAi(vectors: Record<string, number[]>) {
  return {
    async run(_model: string, input: { text: string[] }) {
      const key = Object.keys(vectors).find((k) => input.text[0].includes(k));
      return { data: key ? [vectors[key]] : [] };
    },
  };
}

function makeEnv(db: ReturnType<typeof fakeDb>, ai: unknown): Env {
  return {
    DB: db as unknown as D1Database,
    AI: ai as Ai | undefined,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://example.invalid",
  } as Env;
}

describe("incremental clustering reconciles the old thread after a note moves", () => {
  it("dissolves a thread left with a single note when clustering moves one away", async () => {
    const db = fakeDb();
    // t_old holds notes a + b; re-clustering moves b into x's thread t_new
    db.threads.set("t_old", { id: "t_old", user_id: "u1", title: "旧线索", note_count: 2 });
    db.threads.set("t_new", { id: "t_new", user_id: "u1", title: "跑步", note_count: 1 });
    db.notes.set("a", makeNote("a", "读书笔记", { thread_id: "t_old" }));
    db.notes.set("b", makeNote("b", "跑步计划", { thread_id: "t_old" }));
    db.notes.set("x", makeNote("x", "跑步五公里", { thread_id: "t_new" }));
    db.embeddings.set("x", JSON.stringify([1, 0, 0]));
    db.embeddings.set("a", JSON.stringify([0, 1, 0]));
    const ai = fakeAi({ 跑步计划: [0.99, 0.1, 0] });
    await clusterNote(makeEnv(db, ai), db.notes.get("b")!, { useGraph: false });
    // b moved into t_new with a fresh count
    expect(db.notes.get("b")!.thread_id).toBe("t_new");
    expect(db.threads.get("t_new")!.note_count).toBe(2);
    // t_old was left with only note a -> dissolved, a detached
    expect(db.threads.has("t_old")).toBe(false);
    expect(db.notes.get("a")!.thread_id).toBeNull();
  });

  it("refreshes note_count of the old thread when >=2 notes remain", async () => {
    const db = fakeDb();
    db.threads.set("t_old", { id: "t_old", user_id: "u1", title: "旧线索", note_count: 3 });
    db.threads.set("t_new", { id: "t_new", user_id: "u1", title: "跑步", note_count: 1 });
    db.notes.set("a", makeNote("a", "读书笔记", { thread_id: "t_old" }));
    db.notes.set("c", makeNote("c", "看电影", { thread_id: "t_old" }));
    db.notes.set("b", makeNote("b", "跑步计划", { thread_id: "t_old" }));
    db.notes.set("x", makeNote("x", "跑步五公里", { thread_id: "t_new" }));
    db.embeddings.set("x", JSON.stringify([1, 0, 0]));
    db.embeddings.set("a", JSON.stringify([0, 1, 0]));
    db.embeddings.set("c", JSON.stringify([0, 0, 1]));
    const ai = fakeAi({ 跑步计划: [0.99, 0.1, 0] });
    await clusterNote(makeEnv(db, ai), db.notes.get("b")!, { useGraph: false });
    expect(db.notes.get("b")!.thread_id).toBe("t_new");
    // t_old survives with corrected count
    expect(db.threads.has("t_old")).toBe(true);
    expect(db.threads.get("t_old")!.note_count).toBe(2);
    expect(db.notes.get("a")!.thread_id).toBe("t_old");
    expect(db.notes.get("c")!.thread_id).toBe("t_old");
  });
});

describe("reconcileThread", () => {
  it("deletes an empty thread and dissolves a single-note thread", async () => {
    const db = fakeDb();
    db.threads.set("t0", { id: "t0", user_id: "u1", title: "空", note_count: 2 });
    db.threads.set("t1", { id: "t1", user_id: "u1", title: "单", note_count: 2 });
    db.notes.set("a", makeNote("a", "孤儿", { thread_id: "t1" }));
    const env = makeEnv(db, undefined);
    expect(await reconcileThread(env, "t0")).toBe("deleted");
    expect(await reconcileThread(env, "t1")).toBe("dissolved");
    expect(db.threads.size).toBe(0);
    expect(db.notes.get("a")!.thread_id).toBeNull();
  });

  it("recounts a stale note_count and reports ok when accurate", async () => {
    const db = fakeDb();
    db.threads.set("t1", { id: "t1", user_id: "u1", title: "线索", note_count: 5 });
    db.notes.set("a", makeNote("a", "一", { thread_id: "t1" }));
    db.notes.set("b", makeNote("b", "二", { thread_id: "t1" }));
    const env = makeEnv(db, undefined);
    expect(await reconcileThread(env, "t1", 5)).toBe("recounted");
    expect(db.threads.get("t1")!.note_count).toBe(2);
    expect(await reconcileThread(env, "t1", 2)).toBe("ok");
  });
});
