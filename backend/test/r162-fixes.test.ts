import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env, NoteRow } from "../src/types";
import { ensureNoteEmbedding } from "../src/semantic";

const SRC_DIR = new URL("../src", import.meta.url).pathname;

// ---- P1-1 architectural constraint: single vector-store write path ----
//
// R160 purged zero-signal (pure emoji/symbol) vectors, but threads.ts kept an
// independent embed+save path that resurrected them (audit-r161 P1-1). Like
// the R124 pipeline sinking, the fix is structural: every note_embeddings /
// Vectorize write must live in semantic.ts, where hasSemanticSignal gates it.
// This test fails the build if any other module grows a bypass again.

describe("R162 P1-1 vector-store writes are confined to semantic.ts", () => {
  const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));

  it("no module outside semantic.ts inserts into note_embeddings", () => {
    for (const f of sources) {
      if (f === "semantic.ts") continue;
      const code = readFileSync(join(SRC_DIR, f), "utf8");
      expect(code, `${f} must not write note_embeddings directly — use ensureNoteEmbedding/backfillEmbeddings in semantic.ts`).not.toMatch(
        /INSERT\s+(OR\s+REPLACE\s+)?INTO\s+note_embeddings/i
      );
    }
  });

  it("no module outside semantic.ts upserts into Vectorize", () => {
    for (const f of sources) {
      if (f === "semantic.ts") continue;
      const code = readFileSync(join(SRC_DIR, f), "utf8");
      expect(code, `${f} must not upsert into Vectorize directly`).not.toMatch(/VECTORIZE\s*[.!]+\s*upsert/);
    }
  });
});

// ---- P1-1 gate behavior: ensureNoteEmbedding ----

type EmbeddingStore = Map<string, string>;

function makeEnv(store: EmbeddingStore, aiVector: number[] | null = [0.1, 0.2, 0.3]) {
  const deleted: string[] = [];
  const upserted: string[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.startsWith("SELECT vector FROM note_embeddings")) {
            const v = store.get(binds[0] as string);
            return v !== undefined ? { vector: v } : null;
          }
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.includes("INTO note_embeddings (note_id, vector) VALUES (?, '[]')")) {
            store.set(binds[0] as string, "[]");
            return { meta: { changes: 1 } };
          }
          if (sql.includes("INTO note_embeddings (note_id, vector) VALUES (?, ?)")) {
            store.set(binds[0] as string, binds[1] as string);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  const env = {
    DB: db,
    AI: aiVector ? { run: async () => ({ data: [aiVector] }) } : undefined,
    VECTORIZE: {
      upsert: async (items: { id: string }[]) => {
        upserted.push(...items.map((i) => i.id));
      },
      deleteByIds: async (ids: string[]) => {
        deleted.push(...ids);
      },
    },
  } as unknown as Env;
  return { env, deleted, upserted };
}

const baseNote = () =>
  ({
    id: "n1",
    user_id: "u1",
    is_sensitive: 0,
    title: null,
    content: "买咖啡豆",
    url_title: null,
    url_summary: null,
  }) as unknown as NoteRow;

describe("R162 P1-1 ensureNoteEmbedding gate", () => {
  it("writes the '[]' sentinel (no vector, no Vectorize entry) for zero-signal notes", async () => {
    const store: EmbeddingStore = new Map();
    const { env, deleted, upserted } = makeEnv(store);
    const v = await ensureNoteEmbedding(env, { ...baseNote(), content: "😀🎉🔥" });
    expect(v).toBeNull();
    expect(store.get("n1")).toBe("[]");
    expect(deleted).toEqual(["n1"]);
    expect(upserted).toEqual([]);
  });

  it("never stores anything for sensitive notes", async () => {
    const store: EmbeddingStore = new Map();
    const { env, upserted } = makeEnv(store);
    const v = await ensureNoteEmbedding(env, { ...baseNote(), is_sensitive: 1 });
    expect(v).toBeNull();
    expect(store.size).toBe(0);
    expect(upserted).toEqual([]);
  });

  it("embeds and stores signal-bearing notes, mirroring to Vectorize", async () => {
    const store: EmbeddingStore = new Map();
    const { env, upserted } = makeEnv(store);
    const v = await ensureNoteEmbedding(env, baseNote());
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(store.get("n1")).toBe(JSON.stringify([0.1, 0.2, 0.3]));
    expect(upserted).toEqual(["n1"]);
  });

  it("returns the stored vector without re-embedding", async () => {
    const store: EmbeddingStore = new Map([["n1", JSON.stringify([1, 0, 0])]]);
    const { env } = makeEnv(store, null); // AI unavailable: must not be needed
    const v = await ensureNoteEmbedding(env, baseNote());
    expect(v).toEqual([1, 0, 0]);
  });

  it("re-embeds a formerly zero-signal note once it gains signal", async () => {
    const store: EmbeddingStore = new Map([["n1", "[]"]]);
    const { env } = makeEnv(store);
    const v = await ensureNoteEmbedding(env, baseNote());
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(store.get("n1")).toBe(JSON.stringify([0.1, 0.2, 0.3]));
  });

  it("refresh forces a re-embed even when a vector is stored", async () => {
    const store: EmbeddingStore = new Map([["n1", JSON.stringify([1, 0, 0])]]);
    const { env } = makeEnv(store);
    const v = await ensureNoteEmbedding(env, baseNote(), { refresh: true });
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(store.get("n1")).toBe(JSON.stringify([0.1, 0.2, 0.3]));
  });
});

// ---- P2-1: graph orphan cleanup is scoped to the touched entities ----

describe("R162 P2-1 graph cleanup scoping", () => {
  const graphSrc = readFileSync(join(SRC_DIR, "graph.ts"), "utf8");

  it("no unscoped entity delete remains in graph.ts", () => {
    expect(graphSrc).not.toMatch(/DELETE FROM entities WHERE note_count = 0(?![\s\S]{0,80}id IN)/);
    // the only entity deletes must carry an id-set constraint
    for (const m of graphSrc.match(/DELETE FROM entities[^`"]*/g) ?? []) {
      expect(m).toContain("id IN");
      expect(m).toContain("note_count = 0");
    }
  });
});
