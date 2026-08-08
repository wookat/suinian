import { describe, it, expect } from "vitest";
import { generateDailyReview, KIND_LABEL } from "../src/review";
import type { Env, NoteRow } from "../src/types";

function makeNote(id: string, content: string, extra: Partial<NoteRow> = {}): NoteRow {
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
    todo_due: null,
    todo_done: 0,
    is_sensitive: 0,
    meta: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...extra,
  } as unknown as NoteRow;
}

/**
 * Fake D1 where anniversary/revisit/relaxed queries return nothing, so the
 * only material is the R47 insight candidates (recurring theme / pending todo).
 */
function fakeEnv(opts: { themeNote?: NoteRow; todoNote?: NoteRow }) {
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
          if (sql.includes("GROUP BY thread_id")) {
            return opts.themeNote ? { thread_id: "th-1", n: 3 } : null;
          }
          if (sql.includes("thread_id = ?")) {
            return opts.themeNote ?? null;
          }
          if (sql.includes("datetime(todo_due)")) {
            return opts.todoNote ?? null;
          }
          return null;
        },
        async all() {
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
  return { env: { DB } as unknown as Env, inserted };
}

describe("R47 insight review kinds", () => {
  it("labels exist for the new kinds", () => {
    expect(KIND_LABEL.recurring_theme).toBe("反复出现的主题");
    expect(KIND_LABEL.pending_todo).toBe("悬置的待办");
  });

  it("picks a recurring-theme note when a thread has >=3 recent fragments", async () => {
    const { env, inserted } = fakeEnv({ themeNote: makeNote("n-theme", "主题碎片", { thread_id: "th-1" } as Partial<NoteRow>) });
    const count = await generateDailyReview(env, "u1");
    expect(count).toBe(1);
    expect(inserted[0][4]).toBe("recurring_theme");
    expect(inserted[0][3]).toBe("n-theme");
  });

  it("picks a due/overdue open todo as the pending-todo insight", async () => {
    const { env, inserted } = fakeEnv({ todoNote: makeNote("n-todo", "交报告", { category: "todo", todo_due: "2026-01-02" }) });
    const count = await generateDailyReview(env, "u1");
    expect(count).toBe(1);
    expect(inserted[0][4]).toBe("pending_todo");
    expect(inserted[0][3]).toBe("n-todo");
  });

  it("rotates: only one insight item per day even when both candidates exist", async () => {
    const { env, inserted } = fakeEnv({
      themeNote: makeNote("n-theme", "主题碎片", { thread_id: "th-1" } as Partial<NoteRow>),
      todoNote: makeNote("n-todo", "交报告", { category: "todo", todo_due: "2026-01-02" }),
    });
    const count = await generateDailyReview(env, "u1");
    expect(count).toBe(1);
    expect(["recurring_theme", "pending_todo"]).toContain(inserted[0][4]);
  });
});
