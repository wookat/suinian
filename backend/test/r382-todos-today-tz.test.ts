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

/** 模拟 SQLite datetime()：带偏移的时刻先转 UTC，无偏移 / 纯日期原样当 UTC。 */
function sqliteDatetime(due: string): string {
  if (/[Zz]$|[+-]\d\d:\d\d$/.test(due)) return new Date(due).toISOString().slice(0, 19);
  return due.length === 10 ? `${due}T00:00:00` : due.replace(" ", "T").padEnd(19, ":00").slice(0, 19);
}
const sqliteDate = (due: string) => sqliteDatetime(due).slice(0, 10);
const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const byDue = (a: Row, b: Row) => sqliteDatetime(a.todo_due ?? "").localeCompare(sqliteDatetime(b.todo_due ?? ""));

/** Fake D1：按 SQLite 的 UTC 日期口径执行路由的三条粗筛 SQL（当天窗口 / 更早积压 / 积压计数）。 */
function fakeDb(tz: string, rows: Row[]) {
  const seen: { sql: string; binds: unknown[] }[] = [];
  const backlog = (today: string) => rows.filter((r) => sqliteDate(r.todo_due ?? "") < shiftDays(today, -1));
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
          if (sql.includes("COUNT(*)") && sql.includes("category = 'todo'")) {
            seen.push({ sql, binds });
            return { n: backlog(binds[1] as string).length };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM notes") && sql.includes("category = 'todo'")) {
            seen.push({ sql, binds });
            const today = binds[1] as string;
            const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
            if (sql.includes("BETWEEN date(?, '-1 day') AND date(?, '+1 day')")) {
              const lo = shiftDays(today, -1);
              const hi = shiftDays(today, 1);
              const inWindow = rows.filter((r) => {
                const d = sqliteDate(r.todo_due ?? "");
                return d >= lo && d <= hi;
              });
              return { results: inWindow.sort(byDue).slice(0, limit) };
            }
            if (sql.includes("< date(?, '-1 day')") && sql.includes("DESC")) {
              return { results: backlog(today).sort(byDue).reverse().slice(0, limit) };
            }
            throw new Error(`unexpected todo SQL: ${sql}`);
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
  const body = (await res.json()) as { date: string; items: { id: string; overdue: boolean }[]; overdue_total: number };
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
    expect(body.overdue_total).toBe(1);
    // SQL 粗筛按 UTC 日期放宽一天，精筛在路由内完成
    const windowSql = DB.seen.find((q) => q.sql.includes("BETWEEN"));
    expect(windowSql?.sql).toContain("date(todo_due) BETWEEN date(?, '-1 day') AND date(?, '+1 day')");
    expect(windowSql?.binds.slice(1)).toEqual(["2026-09-10", "2026-09-10"]);
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
      ["legacy-bare", false], // 上海 20:00 = 12:00Z，早于今晚 22 点纽约（02:00Z 次日）
      ["tonight", false],
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

  // R385：过期积压不能把当天到期的挤出列表；此前单条 SQL 按到期升序取前 50，52 条积压 ⇒ 当天 0 条。
  it("keeps every todo due today ahead of an overdue backlog larger than the cap", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T08:30:00Z"), toFake: ["Date"] });
    const rows = Array.from({ length: 52 }, (_, i) => row(`overdue-${i}`, `${shiftDays("2026-09-10", -(i + 2))}T09:00:00+08:00`));
    rows.push(row("yesterday", "2026-09-09T18:00:00+08:00")); // UTC 09-09 —— 落在窗口内的过期行
    rows.push(row("today-a", "2026-09-10T09:00:00+08:00"), row("today-b", "2026-09-10T18:00:00+08:00"));
    rows.push(row("tomorrow", "2026-09-11T07:00:00+08:00"));
    const { body } = await todosToday("Asia/Shanghai", rows);
    expect(body.items).toHaveLength(50);
    expect(body.overdue_total).toBe(53);
    const ids = body.items.map((i) => i.id);
    expect(ids.slice(-3)).toEqual(["yesterday", "today-a", "today-b"]);
    expect(body.items.slice(-2).every((i) => !i.overdue)).toBe(true);
    expect(body.items.slice(0, 48).every((i) => i.overdue)).toBe(true);
    // 保留的是最近的 47 条积压（最老的 5 条被挤掉），且按到期升序
    expect(ids[0]).toBe("overdue-46");
    expect(ids[46]).toBe("overdue-0");
    expect(ids).not.toContain("overdue-47");
    expect(ids).not.toContain("tomorrow");
  });

  it("America/New_York：积压与当天分开取时本地日期口径不变（昨晚 22 点已过期、今晚 22 点今天）", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-10T07:38:00Z"), toFake: ["Date"] });
    const rows = Array.from({ length: 60 }, (_, i) => row(`old-${i}`, `${shiftDays("2026-09-10", -(i + 3))}T09:00:00-04:00`));
    rows.push(row("last-night", "2026-09-09T22:00:00-04:00"), row("tonight", "2026-09-10T22:00:00-04:00"));
    const { body } = await todosToday("America/New_York", rows);
    expect(body.items).toHaveLength(50);
    expect(body.overdue_total).toBe(61);
    expect(body.items.slice(-2).map((i) => [i.id, i.overdue])).toEqual([
      ["last-night", true],
      ["tonight", false],
    ]);
    expect(body.items[0].id).toBe("old-47");
  });
});
