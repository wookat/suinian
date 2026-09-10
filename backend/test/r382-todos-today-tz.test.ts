// R382: GET /api/todos/today 的「今天 / 已过期」按 todo_due 在用户时区的本地日期判定。
// 此前 SQL 用 date(todo_due)（SQLite 先转 UTC 再取日期）比对用户时区的今天：上海用户明早 7 点的待办
// 提前一天出现在今日列表，纽约用户今晚 22 点的待办不出现、跨过 UTC 零点后直接变「已过期」。
import { describe, it, expect, vi, afterEach } from "vitest";
import { app } from "../src/index";
import { todoDueLocalDate } from "../src/triage";

describe("todoDueLocalDate", () => {
  it("converts offset-bearing instants to the user's local date", () => {
    expect(todoDueLocalDate("2026-09-11T07:00:00+08:00", "Asia/Shanghai")).toBe("2026-09-11");
    expect(todoDueLocalDate("2026-09-10T22:00:00-04:00", "America/New_York")).toBe("2026-09-10");
    // 同一瞬间在不同时区的日期不同
    expect(todoDueLocalDate("2026-09-10T22:00:00-04:00", "Asia/Shanghai")).toBe("2026-09-11");
    expect(todoDueLocalDate("2026-09-11T07:00:00+08:00", "America/New_York")).toBe("2026-09-10");
    expect(todoDueLocalDate("2026-09-10T23:30:00.000Z", "Asia/Shanghai")).toBe("2026-09-11");
  });

  it("keeps date-only values verbatim and treats legacy offset-less values as Asia/Shanghai", () => {
    expect(todoDueLocalDate("2026-09-10", "America/New_York")).toBe("2026-09-10");
    expect(todoDueLocalDate("2026-09-11T07:00", "Asia/Shanghai")).toBe("2026-09-11");
    expect(todoDueLocalDate("2026-09-11T07:00:00", "America/New_York")).toBe("2026-09-10");
    expect(todoDueLocalDate("2026-09-11 07:00", "Asia/Shanghai")).toBe("2026-09-11");
  });

  it("returns null for unparseable input", () => {
    expect(todoDueLocalDate("明天下午", "Asia/Shanghai")).toBeNull();
    expect(todoDueLocalDate("", "Asia/Shanghai")).toBeNull();
  });
});

interface Row {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  category: string | null;
  tags: string;
  meta: string | null;
  title: string | null;
  url_title: string | null;
  url_summary: string | null;
  url_titles: string | null;
  is_sensitive: number;
  todo_due: string | null;
  todo_done: number;
  content_enc: string | null;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const row = (id: string, todo_due: string): Row => ({
  id,
  user_id: "u1",
  source: "web",
  raw_type: "text",
  content: `todo ${id}`,
  url: null,
  category: "todo",
  tags: "[]",
  meta: null,
  title: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  is_sensitive: 0,
  todo_due,
  todo_done: 0,
  content_enc: null,
  thread_id: null,
  created_at: "2026-09-01 00:00:00",
  updated_at: "2026-09-01 00:00:00",
  deleted_at: null,
});

/** Fake D1：模拟 SQL 粗筛已放宽一天，把全部候选行交给路由做本地日期判定。 */
function fakeDb(tz: string, rows: Row[]) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  const db = {
    seen,
    async batch() {
      return [];
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users WHERE api_token = ?")) return binds[0] === "tok" ? { id: "u1" } : null;
          if (sql.includes("SELECT tz FROM user_preferences")) return { tz };
          return null;
        },
        async all() {
          if (sql.includes("FROM notes") && sql.includes("category = 'todo'")) {
            seen.push({ sql, binds });
            return { results: rows };
          }
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

async function todosToday(tz: string, rows: Row[]) {
  const DB = fakeDb(tz, rows);
  const res = await app.request(
    new Request("http://local/api/todos/today", { headers: { authorization: "Bearer tok" } }),
    undefined,
    { DB },
    { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { date: string; items: { id: string; overdue: boolean }[] };
  return { body, DB };
}

describe("GET /api/todos/today uses the user's local date", () => {
  afterEach(() => vi.useRealTimers());

  it("Asia/Shanghai：明早 7 点的待办不进今日列表；今早 7 点与昨天的分别为今天 / 已过期", async () => {
    // 2026-09-10 15:38 上海（07:38Z）
    vi.useFakeTimers({ now: new Date("2026-09-10T07:38:00Z"), toFake: ["Date"] });
    const { body, DB } = await todosToday("Asia/Shanghai", [
      row("yesterday", "2026-09-09T18:00:00+08:00"),
      row("today-early", "2026-09-10T07:00:00+08:00"),
      row("date-only-today", "2026-09-10"),
      row("tomorrow-early", "2026-09-11T07:00:00+08:00"), // UTC 09-10 23:00 —— date() 会算成今天
    ]);
    expect(body.date).toBe("2026-09-10");
    expect(body.items.map((i) => [i.id, i.overdue])).toEqual([
      ["yesterday", true],
      ["today-early", false],
      ["date-only-today", false],
    ]);
    // SQL 粗筛放宽一天，精筛在路由内完成
    expect(DB.seen[0].sql).toContain("date(todo_due) <= date(?, '+1 day')");
    expect(DB.seen[0].binds[1]).toBe("2026-09-10");
  });

  it("America/New_York：今晚 22 点的待办算今天（此前 UTC 已是次日而被漏掉）", async () => {
    // 2026-09-10 03:38 纽约（07:38Z）
    vi.useFakeTimers({ now: new Date("2026-09-10T07:38:00Z"), toFake: ["Date"] });
    const { body } = await todosToday("America/New_York", [
      row("last-night", "2026-09-09T22:00:00-04:00"), // UTC 09-10 02:00
      row("tonight", "2026-09-10T22:00:00-04:00"), // UTC 09-11 02:00
      row("tomorrow", "2026-09-11T09:00:00-04:00"),
      row("legacy-bare", "2026-09-10T20:00"), // 历史无偏移 = 上海 20:00 = 纽约 08:00 今天
    ]);
    expect(body.date).toBe("2026-09-10");
    expect(body.items.map((i) => [i.id, i.overdue])).toEqual([
      ["last-night", true],
      ["tonight", false],
      ["legacy-bare", false],
    ]);
  });

  it("caps the list at 50 after local-date filtering", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T07:38:00Z"), toFake: ["Date"] });
    const rows = Array.from({ length: 70 }, (_, i) => row(`t${i}`, "2026-09-10T09:00:00+08:00"));
    rows.unshift(row("future", "2026-09-12T09:00:00+08:00"));
    const { body } = await todosToday("Asia/Shanghai", rows);
    expect(body.items).toHaveLength(50);
    expect(body.items.some((i) => i.id === "future")).toBe(false);
  });
});
