// R132 (audit-r131 D-4): mergeDuplicateThreads folds threads carrying the
// exact same title even when their representatives' embeddings drift apart.
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
  title: string;
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
                .map((t) => ({ id: t.id, created_at: t.created_at, title: t.title })),
            };
          }
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql.includes("FROM notes n LEFT JOIN note_embeddings")) {
            const candidates = [...noteMap.values()]
              .filter((n) => n.thread_id === binds[0] && n.deleted_at === null && n.is_sensitive === 0)
              .sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
            const top = candidates[0];
            return top
              ? { id: top.id, title: null, content: "内容", url_title: null, url_summary: null, vector: vectors[top.id] ? JSON.stringify(vectors[top.id]) : null }
              : null;
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

describe("mergeDuplicateThreads same-title fold (R132 D-4)", () => {
  it("folds two threads with identical titles into the older one", async () => {
    const { env, noteMap, threadMap } = fakeEnv(
      [note("n1", "tA", "2026-08-01 10:00:00"), note("n2", "tA", "2026-08-01 10:00:05"), note("n3", "tB", "2026-08-02 10:00:00"), note("n4", "tB", "2026-08-02 10:00:05")],
      [
        { id: "tA", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:01", title: "中国各地美食清单" },
        { id: "tB", user_id: "u1", note_count: 2, created_at: "2026-08-02 10:00:01", title: "中国各地美食清单" },
      ],
      { n2: [1, 0, 0], n4: [0, 1, 0] } // orthogonal reps: embedding path alone would NOT merge
    );
    const merged = await mergeDuplicateThreads(env, "u1");
    expect(merged).toBe(1);
    expect(threadMap.has("tB")).toBe(false);
    expect(threadMap.get("tA")!.note_count).toBe(4);
    expect([...noteMap.values()].every((n) => n.thread_id === "tA")).toBe(true);
  });

  it("does not fold on the generic fallback title or different titles", async () => {
    const { env, threadMap } = fakeEnv(
      [note("n1", "tA", "2026-08-01 10:00:00"), note("n2", "tA", "2026-08-01 10:00:05"), note("n3", "tB", "2026-08-02 10:00:00"), note("n4", "tB", "2026-08-02 10:00:05"), note("n5", "tC", "2026-08-03 10:00:00"), note("n6", "tC", "2026-08-03 10:00:05"), note("n7", "tD", "2026-08-04 10:00:00"), note("n8", "tD", "2026-08-04 10:00:05")],
      [
        { id: "tA", user_id: "u1", note_count: 2, created_at: "2026-08-01 10:00:01", title: "未命名线索" },
        { id: "tB", user_id: "u1", note_count: 2, created_at: "2026-08-02 10:00:01", title: "未命名线索" },
        { id: "tC", user_id: "u1", note_count: 2, created_at: "2026-08-03 10:00:01", title: "读书笔记" },
        { id: "tD", user_id: "u1", note_count: 2, created_at: "2026-08-04 10:00:01", title: "健身记录" },
      ],
      { n2: [1, 0, 0], n4: [0, 1, 0], n6: [0, 0, 1], n8: [0.5, 0.5, 0] }
    );
    const merged = await mergeDuplicateThreads(env, "u1");
    expect(merged).toBe(0);
    expect(threadMap.size).toBe(4);
  });
});
