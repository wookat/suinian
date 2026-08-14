// R110 (R109 P2-1): mergeDuplicateThreads folds same-topic threads created by
// concurrent clustering back into one.
import { describe, it, expect } from "vitest";
import { mergeDuplicateThreads } from "../src/threads";
import type { Env } from "../src/types";

interface FakeNote {
  id: string;
  user_id: string;
  thread_id: string | null;
  created_at: string;
  deleted_at: string | null;
  is_sensitive: number;
}
interface FakeThread {
  id: string;
  user_id: string;
  note_count: number;
  created_at: string;
}

function fakeEnv(notes: FakeNote[], threads: FakeThread[], vectors: Record<string, number[]>) {
  const noteMap = new Map(notes.map((n) => [n.id, { ...n }]));
  const threadMap = new Map(threads.map((t) => [t.id, { ...t }]));
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async all() {
          if (sql.includes("FROM threads WHERE user_id")) {
            return {
              results: [...threadMap.values()]
                .filter((t) => t.user_id === binds[0] && t.note_count > 0)
                .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
                .map((t) => ({ id: t.id, created_at: t.created_at })),
            };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql.includes("FROM notes n JOIN note_embeddings")) {
            const candidates = [...noteMap.values()]
              .filter((n) => n.thread_id === binds[0] && n.deleted_at === null && n.is_sensitive === 0 && vectors[n.id])
              .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
            const top = candidates[0];
            return top ? { vector: JSON.stringify(vectors[top.id]) } : null;
          }
          if (sql.includes("COUNT(*) AS c FROM notes WHERE thread_id")) {
            let c = 0;
            for (const n of noteMap.values()) if (n.thread_id === binds[0] && n.deleted_at === null) c++;
            return { c };
          }
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET thread_id = ?")) {
            for (const n of noteMap.values()) if (n.thread_id === binds[1]) n.thread_id = binds[0] as string;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET thread_id = NULL")) {
            for (const n of noteMap.values()) if (n.thread_id === binds[0]) n.thread_id = null;
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("DELETE FROM threads WHERE id")) {
            threadMap.delete(binds[0] as string);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE threads SET note_count")) {
            const t = threadMap.get(binds[1] as string);
            if (t) t.note_count = binds[0] as number;
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as unknown as Env, noteMap, threadMap };
}

const note = (id: string, thread: string, at: string): FakeNote => ({
  id,
  user_id: "u1",
  thread_id: thread,
  created_at: at,
  deleted_at: null,
  is_sensitive: 0,
});

describe("mergeDuplicateThreads", () => {
  it("folds a concurrent duplicate thread into the older one", async () => {
    const { env, noteMap, threadMap } = fakeEnv(
      [note("n1", "tA", "2026-08-01 10:00:00"), note("n2", "tA", "2026-08-01 10:00:05"), note("n3", "tB", "2026-08-01 10:00:06"), note("n4", "tB", "2026-08-01 10:00:07")],
      [
        { id: "tA", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:01" },
        { id: "tB", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:06" },
      ],
      { n2: [1, 0, 0], n4: [0.99, 0.1, 0] } // cosine ≈ 0.995 ≥ SIM_JOIN
    );
    const merged = await mergeDuplicateThreads(env, "u1", "tB");
    expect(merged).toBe(1);
    expect(threadMap.has("tB")).toBe(false);
    expect(threadMap.get("tA")!.note_count).toBe(4);
    expect([...noteMap.values()].every((n) => n.thread_id === "tA")).toBe(true);
  });

  it("leaves unrelated threads alone", async () => {
    const { env, threadMap } = fakeEnv(
      [note("n1", "tA", "2026-08-01 10:00:00"), note("n2", "tA", "2026-08-01 10:00:05"), note("n3", "tB", "2026-08-01 10:00:06"), note("n4", "tB", "2026-08-01 10:00:07")],
      [
        { id: "tA", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:01" },
        { id: "tB", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:06" },
      ],
      { n2: [1, 0, 0], n4: [0, 1, 0] } // orthogonal topics
    );
    const merged = await mergeDuplicateThreads(env, "u1", "tB");
    expect(merged).toBe(0);
    expect(threadMap.has("tA")).toBe(true);
    expect(threadMap.has("tB")).toBe(true);
  });

  it("without a scope, sweeps every duplicate pair of the user", async () => {
    const { env, threadMap } = fakeEnv(
      [note("n1", "tA", "2026-08-01 10:00:00"), note("n2", "tA", "2026-08-01 10:00:05"), note("n3", "tB", "2026-08-01 10:00:06"), note("n4", "tB", "2026-08-01 10:00:07")],
      [
        { id: "tA", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:01" },
        { id: "tB", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:06" },
      ],
      { n2: [1, 0, 0], n4: [1, 0, 0] }
    );
    expect(await mergeDuplicateThreads(env, "u1")).toBe(1);
    expect(threadMap.has("tB")).toBe(false);
  });

  it("never throws on a broken DB", async () => {
    const env = { DB: { prepare() { throw new Error("boom"); } } } as unknown as Env;
    expect(await mergeDuplicateThreads(env, "u1", "t1")).toBe(0);
  });
});
