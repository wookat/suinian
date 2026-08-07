import { describe, it, expect } from "vitest";
import { reconcileThreads } from "../src/threads";
import type { Env } from "../src/types";

interface FakeNote {
  id: string;
  user_id: string;
  thread_id: string | null;
}
interface FakeThread {
  id: string;
  user_id: string;
  note_count: number;
}

// In-memory fake D1 covering the SQL used by reconcileThreads
function fakeEnv(notes: FakeNote[], threads: FakeThread[]) {
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
                .filter((t) => t.user_id === binds[0])
                .map((t) => ({ id: t.id, note_count: t.note_count })),
            };
          }
          if (sql.includes("FROM threads")) {
            return { results: [...threadMap.values()].map((t) => ({ id: t.id, note_count: t.note_count })) };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql.includes("COUNT(*) AS c FROM notes WHERE thread_id")) {
            if (binds[0] === "t_boom") throw new Error("D1 exploded");
            let c = 0;
            for (const n of noteMap.values()) if (n.thread_id === binds[0]) c++;
            return { c };
          }
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith("DELETE FROM threads WHERE id")) {
            threadMap.delete(binds[0] as string);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET thread_id = NULL")) {
            for (const n of noteMap.values()) if (n.thread_id === binds[0]) n.thread_id = null;
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

describe("reconcileThreads", () => {
  it("deletes orphan threads whose notes were all removed", async () => {
    const { env, threadMap } = fakeEnv([], [{ id: "t1", user_id: "u1", note_count: 2 }]);
    const r = await reconcileThreads(env, "u1");
    expect(r.deleted).toBe(1);
    expect(threadMap.has("t1")).toBe(false);
  });

  it("dissolves a thread left with a single note and detaches the note", async () => {
    const { env, noteMap, threadMap } = fakeEnv(
      [{ id: "n1", user_id: "u1", thread_id: "t1" }],
      [{ id: "t1", user_id: "u1", note_count: 2 }]
    );
    const r = await reconcileThreads(env, "u1");
    expect(r.dissolved).toBe(1);
    expect(threadMap.has("t1")).toBe(false);
    expect(noteMap.get("n1")!.thread_id).toBeNull();
  });

  it("fixes a stale note_count and keeps healthy threads", async () => {
    const { env, threadMap } = fakeEnv(
      [
        { id: "n1", user_id: "u1", thread_id: "t1" },
        { id: "n2", user_id: "u1", thread_id: "t1" },
        { id: "n3", user_id: "u1", thread_id: "t1" },
      ],
      [{ id: "t1", user_id: "u1", note_count: 5 }]
    );
    const r = await reconcileThreads(env, "u1");
    expect(r.deleted).toBe(0);
    expect(r.dissolved).toBe(0);
    expect(threadMap.get("t1")!.note_count).toBe(3);
  });

  it("scopes to the given user and sweeps all threads without one", async () => {
    const { env, threadMap } = fakeEnv([], [
      { id: "t1", user_id: "u1", note_count: 2 },
      { id: "t2", user_id: "u2", note_count: 2 },
    ]);
    await reconcileThreads(env, "u1");
    expect(threadMap.has("t1")).toBe(false);
    expect(threadMap.has("t2")).toBe(true);
    await reconcileThreads(env);
    expect(threadMap.has("t2")).toBe(false);
  });

  it("keeps sweeping when one thread's queries fail", async () => {
    const { env, threadMap } = fakeEnv([], [
      { id: "t_boom", user_id: "u1", note_count: 2 },
      { id: "t_orphan", user_id: "u1", note_count: 2 },
    ]);
    const r = await reconcileThreads(env);
    expect(r.deleted).toBe(1);
    expect(threadMap.has("t_boom")).toBe(true);
    expect(threadMap.has("t_orphan")).toBe(false);
  });
});
