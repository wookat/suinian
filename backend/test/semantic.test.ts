import { describe, it, expect, vi } from "vitest";
import {
  upsertNoteEmbedding,
  deleteNoteEmbedding,
  semanticRecall,
  backfillEmbeddings,
  noteEmbedText,
} from "../src/semantic";
import type { Env, NoteRow } from "../src/types";

function note(over: Partial<NoteRow>): NoteRow {
  return {
    id: "n1",
    user_id: "u1",
    source: "api",
    raw_type: "text",
    content: "坚持每天写一点，比一次写很多更重要",
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
    ...over,
  };
}

/** Minimal fake D1 recording note_embeddings writes/deletes + serving recall queries. */
function fakeDb(rows: { note_id: string; vector: string }[] = []) {
  const inserted: unknown[][] = [];
  const deleted: unknown[][] = [];
  const db = {
    inserted,
    deleted,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (sql.startsWith("INSERT OR REPLACE INTO note_embeddings")) inserted.push(binds);
          if (sql.startsWith("DELETE FROM note_embeddings")) deleted.push(binds);
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: rows };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  };
  return db;
}

function envWith(db: ReturnType<typeof fakeDb>, vec: number[] | null, vectorize?: object): Env {
  return {
    DB: db as unknown as D1Database,
    AI: {
      run: vi.fn(async () => ({ data: vec ? [vec] : [] })),
    } as unknown as Ai,
    VECTORIZE: vectorize as unknown as VectorizeIndex | undefined,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
  };
}

describe("noteEmbedText", () => {
  it("joins title/content/link metadata", () => {
    const t = noteEmbedText(note({ title: "标题", url_title: "文章标题", url_summary: "摘要" }));
    expect(t).toBe("标题\n坚持每天写一点，比一次写很多更重要\n文章标题\n摘要");
  });
});

describe("upsertNoteEmbedding", () => {
  it("stores the vector in D1 and mirrors to Vectorize when bound", async () => {
    const db = fakeDb();
    const upsert = vi.fn(async () => ({}));
    const env = envWith(db, [0.1, 0.2], { upsert });
    await upsertNoteEmbedding(env, note({}));
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0][0]).toBe("n1");
    expect(upsert).toHaveBeenCalledWith([
      { id: "n1", values: [0.1, 0.2], metadata: { user_id: "u1" } },
    ]);
  });

  it("sensitive notes never enter the vector store: deletes instead of embedding", async () => {
    const db = fakeDb();
    const deleteByIds = vi.fn(async () => ({}));
    const env = envWith(db, [0.1, 0.2], { deleteByIds });
    await upsertNoteEmbedding(env, note({ is_sensitive: 1 }));
    expect(db.inserted).toHaveLength(0);
    expect(db.deleted).toHaveLength(1);
    expect(deleteByIds).toHaveBeenCalledWith(["n1"]);
    expect((env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it("no-ops when embedding fails", async () => {
    const db = fakeDb();
    const env = envWith(db, null);
    await upsertNoteEmbedding(env, note({}));
    expect(db.inserted).toHaveLength(0);
  });
});

describe("deleteNoteEmbedding", () => {
  it("removes from D1 and Vectorize", async () => {
    const db = fakeDb();
    const deleteByIds = vi.fn(async () => ({}));
    await deleteNoteEmbedding(envWith(db, null, { deleteByIds }), "n9");
    expect(db.deleted[0][0]).toBe("n9");
    expect(deleteByIds).toHaveBeenCalledWith(["n9"]);
  });
});

describe("semanticRecall", () => {
  it("uses Vectorize with a user_id filter when bound", async () => {
    const db = fakeDb();
    const query = vi.fn(async () => ({
      matches: [
        { id: "a", score: 0.8 },
        { id: "b", score: 0.3 },
      ],
    }));
    const hits = await semanticRecall(envWith(db, [1, 0], { query }), "u1", "关于坚持的想法");
    expect(query).toHaveBeenCalledWith([1, 0], expect.objectContaining({ filter: { user_id: "u1" } }));
    expect(hits).toEqual([{ note_id: "a", score: 0.8 }]);
  });

  it("falls back to brute-force cosine over D1 vectors, sorted and thresholded", async () => {
    const db = fakeDb([
      { note_id: "near", vector: JSON.stringify([1, 0.1]) },
      { note_id: "far", vector: JSON.stringify([-1, 0.5]) },
      { note_id: "bad", vector: "not json" },
    ]);
    const hits = await semanticRecall(envWith(db, [1, 0]), "u1", "查询");
    expect(hits.map((h) => h.note_id)).toEqual(["near"]);
    expect(hits[0].score).toBeGreaterThan(0.9);
  });

  it("returns [] when the query embedding fails (degrade to keyword)", async () => {
    const hits = await semanticRecall(envWith(fakeDb(), null), "u1", "查询");
    expect(hits).toEqual([]);
  });

  it("returns [] when Vectorize throws (degrade to keyword)", async () => {
    const query = vi.fn(async () => {
      throw new Error("boom");
    });
    const hits = await semanticRecall(envWith(fakeDb(), [1, 0], { query }), "u1", "查询");
    expect(hits).toEqual([]);
  });
});

describe("backfillEmbeddings", () => {
  it("embeds notes returned by the missing-vector query", async () => {
    const rows = [note({ id: "x1" }), note({ id: "x2" })];
    const inserted: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async all() {
            return { results: rows };
          },
          async run() {
            if (sql.startsWith("INSERT OR REPLACE INTO note_embeddings")) inserted.push(binds);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    const env = envWith(db as unknown as ReturnType<typeof fakeDb>, [0.5, 0.5]);
    const done = await backfillEmbeddings(env, 5);
    expect(done).toBe(2);
    expect(inserted.map((b) => b[0])).toEqual(["x1", "x2"]);
  });
});
