import { describe, it, expect } from "vitest";
import { generateDailyReview, todoDueInstantMs, PENDING_TODO_WINDOW_MS } from "../src/review";
import type { Env, NoteRow } from "../src/types";

/**
 * R387：「悬置的待办」候选的 48h 窗口按待办真实到期瞬间判定。此前 SQL `datetime(todo_due) <= datetime('now','+2 days')`
 * 把历史无偏移值当 UTC（比真实 Asia/Shanghai 时刻晚 8h），本机 D1 实录：bare `2026-09-12T15:50:55`（= now +47h）
 * in_window=0、回顾 items=0。
 */

const H = 3600_000;
const NOW = new Date("2026-09-10T16:50:57Z"); // 上海 09-11 00:50；纽约 09-10 12:50

function todo(id: string, due: string, extra: Partial<NoteRow> = {}): NoteRow {
  return {
    id,
    user_id: "u1",
    source: "web",
    raw_type: "text",
    content: `待办 ${id}`,
    url: null,
    title: null,
    category: "todo",
    tags: "[]",
    todo_due: due,
    todo_done: 0,
    is_sensitive: 0,
    meta: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...extra,
  } as unknown as NoteRow;
}

/** SQLite datetime() 口径（sqlite 3.37 实测）：无偏移按 UTC、带偏移换算、纯日期 = 00:00 UTC、非法 null */
function sqliteDatetimeMs(v: string): number | null {
  const s = v.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(s) ? Date.parse(`${s}Z`) : Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 只让「悬置的待办」有料的 fake D1：按 SQLite 口径真正执行粗筛 SQL 的 WHERE / ORDER BY / LIMIT */
function fakeEnv(tz: string | null, notes: NoteRow[]) {
  const inserted: unknown[][] = [];
  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("COUNT(*) AS n FROM daily_reviews")) return { n: 0 };
          if (sql.includes("SELECT tz FROM user_preferences")) return { tz };
          return null;
        },
        async all() {
          if (!sql.includes("datetime(todo_due)")) return { results: [] };
          expect(sql).toContain("datetime(?, '+3 days')");
          const limit = parseInt(sql.match(/LIMIT (\d+)/)![1], 10);
          const nowMs = Date.parse(String(binds[1]));
          const rows = notes
            .filter((n) => n.user_id === binds[0] && n.category === "todo" && !n.todo_done && n.todo_due)
            .map((n) => ({ n, at: sqliteDatetimeMs(n.todo_due!) }))
            .filter((x): x is { n: NoteRow; at: number } => x.at !== null && x.at <= nowMs + 3 * 86400_000)
            .sort((a, b) => a.at - b.at)
            .slice(0, limit)
            .map((x) => x.n);
          return { results: rows };
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

async function pick(tz: string | null, notes: NoteRow[]): Promise<string | null> {
  const { env, inserted } = fakeEnv(tz, notes);
  const n = await generateDailyReview(env, "u1", NOW);
  if (n === 0) return null;
  expect(inserted[0][4]).toBe("pending_todo");
  return inserted[0][3] as string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** 上海本地墙钟（无偏移历史形态） */
const bareShanghai = (ms: number) => new Date(ms + 8 * H).toISOString().slice(0, 19);
const withOffset = (ms: number, off: string, offH: number) => `${new Date(ms + offH * H).toISOString().slice(0, 19)}${off}`;

describe("todoDueInstantMs", () => {
  it("offset-bearing values are instants regardless of tz", () => {
    expect(todoDueInstantMs("2026-09-12T15:50:55+08:00", "America/New_York")).toBe(Date.parse("2026-09-12T07:50:55Z"));
    expect(todoDueInstantMs("2026-09-12T22:00:00-04:00", "Asia/Shanghai")).toBe(Date.parse("2026-09-13T02:00:00Z"));
    expect(todoDueInstantMs("2026-09-12T15:00:00.000Z", "Asia/Shanghai")).toBe(Date.parse("2026-09-12T15:00:00Z"));
  });
  it("legacy bare datetime is Asia/Shanghai (normalizeStoredTodoDue 同口径), not user tz", () => {
    expect(todoDueInstantMs("2026-09-12T15:50:55", "America/New_York")).toBe(Date.parse("2026-09-12T07:50:55Z"));
    expect(todoDueInstantMs("2026-09-12 15:50", "Asia/Shanghai")).toBe(Date.parse("2026-09-12T07:50:00Z"));
  });
  it("bare date = 09:00 in the user's tz (push.ts 提醒同口径, DST-aware)", () => {
    expect(todoDueInstantMs("2026-09-12", "Asia/Shanghai")).toBe(Date.parse("2026-09-12T01:00:00Z"));
    expect(todoDueInstantMs("2026-09-12", "America/New_York")).toBe(Date.parse("2026-09-12T13:00:00Z"));
    expect(todoDueInstantMs("2026-12-12", "America/New_York")).toBe(Date.parse("2026-12-12T14:00:00Z"));
    expect(todoDueInstantMs("2026-09-12", "Not/AZone")).toBe(Date.parse("2026-09-12T01:00:00Z"));
  });
  it("invalid → null", () => {
    expect(todoDueInstantMs("明天下午", "Asia/Shanghai")).toBeNull();
    expect(todoDueInstantMs("2026/09/12 18:00", "Asia/Shanghai")).toBeNull();
  });
});

describe("R387 pendingTodoCandidate window by real due instant", () => {
  it("Shanghai legacy bare row at +47h is picked (D1 实录：此前被当 UTC 排除)", async () => {
    const due = bareShanghai(NOW.getTime() + 47 * H);
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(await pick("Asia/Shanghai", [todo("bare47", due)])).toBe("bare47");
  });

  it("Shanghai legacy bare row at +49h is excluded", async () => {
    expect(await pick("Asia/Shanghai", [todo("bare49", bareShanghai(NOW.getTime() + 49 * H))])).toBeNull();
  });

  it("offset-bearing +47h included / +49h excluded for Shanghai and New York", async () => {
    const t = NOW.getTime();
    expect(await pick("Asia/Shanghai", [todo("sh47", withOffset(t + 47 * H, "+08:00", 8))])).toBe("sh47");
    expect(await pick("Asia/Shanghai", [todo("sh49", withOffset(t + 49 * H, "+08:00", 8))])).toBeNull();
    expect(await pick("America/New_York", [todo("ny47", withOffset(t + 47 * H, "-04:00", -4))])).toBe("ny47");
    expect(await pick("America/New_York", [todo("ny49", withOffset(t + 49 * H, "-04:00", -4))])).toBeNull();
    expect(await pick(null, [todo("z47", iso(t + 47 * H))])).toBe("z47");
  });

  it("orders by real instant: legacy bare row due earlier wins over an offset row SQLite sorts first", async () => {
    const t = NOW.getTime();
    // bare 上海 +10h（SQLite 误读成 +18h）vs 带偏移 +12h：真实更早的是 bare
    const rows = [todo("off12", iso(t + 12 * H)), todo("bare10", bareShanghai(t + 10 * H))];
    expect(await pick("Asia/Shanghai", rows)).toBe("bare10");
  });

  it("New York bare date two days out (09:00 local = 13:00Z) is not yet within 48h although SQLite's 00:00Z is", async () => {
    // NOW 纽约 09-10 12:50 → 09-12 09:00 纽约 = +44h10m 在窗口内；09-13 = +68h 不在（SQLite 按 09-13 00:00Z = +55h 也不在，
    // 但 09-12 00:00Z = +31h 时 SQL 与真实都纳入——用 +2 天 09:00 纽约的边界：now 改到 09-10 08:00 纽约即可分出差别）
    const now = new Date("2026-09-10T12:00:00Z"); // 纽约 08:00；09-12 09:00 纽约 = 13:00Z = +49h
    const { env, inserted } = fakeEnv("America/New_York", [todo("d2", "2026-09-12")]);
    expect(await generateDailyReview(env, "u1", now)).toBe(0);
    expect(inserted.length).toBe(0);
    // 上海用户同一纯日期：09-12 09:00 上海 = 01:00Z = +37h → 纳入
    const sh = fakeEnv("Asia/Shanghai", [todo("d2", "2026-09-12")]);
    expect(await generateDailyReview(sh.env, "u1", now)).toBe(1);
  });

  it("overdue rows are picked and the earliest overdue wins; invalid due is skipped", async () => {
    const t = NOW.getTime();
    const rows = [todo("late1", iso(t - 1 * H)), todo("late30", iso(t - 30 * H)), todo("bad", "明天下午")];
    expect(await pick("Asia/Shanghai", rows)).toBe("late30");
  });

  it("coarse window is bounded by PENDING_TODO_WINDOW_MS = 48h", () => {
    expect(PENDING_TODO_WINDOW_MS).toBe(48 * H);
  });
});
