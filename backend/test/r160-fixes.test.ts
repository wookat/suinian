import { describe, it, expect } from "vitest";
import type { Env, NoteRow } from "../src/types";
import {
  hasSemanticSignal,
  noteEmbedText,
  purgeLowSignalEmbeddings,
  semanticRecall,
  SEMANTIC_MIN_SCORE,
} from "../src/semantic";
import { ENUM_TOPIC_CATEGORIES } from "../src/ask";

// ---- P1-1: zero-signal notes must not poison semantic recall ----

describe("R160 P1-1 hasSemanticSignal", () => {
  it("treats pure emoji / symbol / whitespace text as zero-signal", () => {
    expect(hasSemanticSignal("😀🎉🔥")).toBe(false);
    expect(hasSemanticSignal("！？。、～")).toBe(false);
    expect(hasSemanticSignal("---***///")).toBe(false);
    expect(hasSemanticSignal("   ")).toBe(false);
    expect(hasSemanticSignal("")).toBe(false);
  });

  it("keeps any text with a letter or digit in any script", () => {
    expect(hasSemanticSignal("买咖啡豆")).toBe(true);
    expect(hasSemanticSignal("hello")).toBe(true);
    expect(hasSemanticSignal("😀 3 个")).toBe(true);
    expect(hasSemanticSignal("日本語メモ")).toBe(true);
    expect(hasSemanticSignal("№5")).toBe(true);
  });
});

// ---- shared fake D1 for embedding-store tests ----

type EmbeddingRow = { note_id: string; vector: string };

function fakeEnv(notes: Partial<NoteRow>[], embeddings: EmbeddingRow[]) {
  const deletedFromVectorize: string[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("COUNT(*)")) {
            const userId = binds[0];
            const cnt = embeddings.filter((e) => {
              const n = notes.find((n) => n.id === e.note_id);
              return n && n.user_id === userId && !n.is_sensitive && e.vector !== "[]";
            }).length;
            return { cnt };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM notes n") && sql.includes("JOIN note_embeddings e")) {
            // purge query: notes that still have a real vector
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
          if (sql.includes("FROM note_embeddings e")) {
            // recall query: user's non-sensitive real vectors
            const userId = binds[0];
            const limit = binds[1] as number;
            const offset = binds[2] as number;
            const rows = embeddings
              .filter((e) => {
                const n = notes.find((n) => n.id === e.note_id);
                return n && n.user_id === userId && !n.is_sensitive && e.vector !== "[]";
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
  const env = {
    DB: db,
    AI: {
      async run() {
        // deterministic unit query vector
        return { data: [[1, 0]] };
      },
    },
    VECTORIZE: undefined,
  } as unknown as Env & { VECTORIZE?: { deleteByIds(ids: string[]): Promise<void> } };
  return { env, embeddings, deletedFromVectorize };
}

const N = (id: string, content: string, over: Partial<NoteRow> = {}): Partial<NoteRow> => ({
  id,
  user_id: "u1",
  content,
  title: null,
  url_title: null,
  url_summary: null,
  is_sensitive: 0,
  ...over,
});

describe("R160 P1-1 sentinel exclusion in D1 recall", () => {
  it("ignores '[]' sentinel rows and applies the calibrated threshold", async () => {
    // vectors in 2-D: query is [1,0]; cos = x component for unit vectors
    const notes = [N("rel", "煮咖啡"), N("mid", "西语"), N("emoji", "😀😀")];
    const { env } = fakeEnv(notes, [
      { note_id: "rel", vector: JSON.stringify([0.9, Math.sqrt(1 - 0.81)]) },
      { note_id: "mid", vector: JSON.stringify([0.4, Math.sqrt(1 - 0.16)]) },
      { note_id: "emoji", vector: "[]" },
    ]);
    // corpus < 20 → small-corpus floor 0.6 applies; 0.9 passes, 0.4 fails,
    // emoji sentinel never even scores
    const hits = await semanticRecall(env, "u1", "咖啡设备");
    expect(hits.map((h) => h.note_id)).toEqual(["rel"]);
    expect(hits[0].score).toBeGreaterThanOrEqual(SEMANTIC_MIN_SCORE);
  });
});

describe("R160 P1-1 purgeLowSignalEmbeddings", () => {
  it("marks stored zero-signal vectors with the '[]' sentinel and leaves real notes alone", async () => {
    const notes = [N("a", "买咖啡豆"), N("b", "😀🎉"), N("c", "！！！"), N("d", "hello")];
    const { env, embeddings } = fakeEnv(notes, [
      { note_id: "a", vector: "[0.1,0.2]" },
      { note_id: "b", vector: "[0.3,0.4]" },
      { note_id: "c", vector: "[0.5,0.6]" },
      { note_id: "d", vector: "[0.7,0.8]" },
    ]);
    const purged = await purgeLowSignalEmbeddings(env);
    expect(purged).toBe(2);
    expect(embeddings.find((e) => e.note_id === "b")?.vector).toBe("[]");
    expect(embeddings.find((e) => e.note_id === "c")?.vector).toBe("[]");
    expect(embeddings.find((e) => e.note_id === "a")?.vector).toBe("[0.1,0.2]");
    expect(embeddings.find((e) => e.note_id === "d")?.vector).toBe("[0.7,0.8]");
  });

  it("is idempotent", async () => {
    const notes = [N("b", "😀🎉")];
    const { env } = fakeEnv(notes, [{ note_id: "b", vector: "[0.3,0.4]" }]);
    expect(await purgeLowSignalEmbeddings(env)).toBe(1);
    expect(await purgeLowSignalEmbeddings(env)).toBe(0);
  });
});

describe("R160 P1-1 noteEmbedText", () => {
  it("joins title/content/link metadata so a link-only emoji note still has signal", () => {
    const n = { title: null, content: "😀", url_title: "Coffee guide", url_summary: null } as NoteRow;
    expect(hasSemanticSignal(noteEmbedText(n))).toBe(true);
  });
});

// ---- P2-1: enumeration topics that name a category enumerate by category ----

describe("R160 P2-1 ENUM_TOPIC_CATEGORIES", () => {
  it("maps exact category nouns to note categories", () => {
    expect(ENUM_TOPIC_CATEGORIES["待办"]).toBe("todo");
    expect(ENUM_TOPIC_CATEGORIES["待办事项"]).toBe("todo");
    expect(ENUM_TOPIC_CATEGORIES["想法"]).toBe("idea");
    expect(ENUM_TOPIC_CATEGORIES["点子"]).toBe("idea");
    expect(ENUM_TOPIC_CATEGORIES["收藏"]).toBe("collect");
    expect(ENUM_TOPIC_CATEGORIES["资料"]).toBe("data");
  });

  it("leaves ordinary keyword topics unmapped so LIKE filtering still applies", () => {
    expect(ENUM_TOPIC_CATEGORIES["咖啡"]).toBeUndefined();
    expect(ENUM_TOPIC_CATEGORIES["书"]).toBeUndefined();
  });
});
