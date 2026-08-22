import { describe, it, expect } from "vitest";
import {
  buildFinanceSubsetZeroHitAnswer,
  buildFinanceAggAnswer,
  timeRangeAvgDays,
  FINANCE_AVG_PER_DAY_RE,
  financeTopicTerms,
  parseTimeRange,
  enumTopicCategory,
  resolveAskEnumIntent,
  topicEnumIntent,
  type TimeRange,
} from "../src/ask";
import type { FinanceStats } from "../src/reports";

const MAY: TimeRange = { start: "2026-04-30 16:00:00", end: "2026-05-31 16:00:00", phrase: "2026年5月" };

function stats(expense: number, count: number, income = 0, incomeCount = 0): FinanceStats {
  return {
    expenseCount: count,
    incomeCount,
    transferCount: 0,
    totals: { CNY: { expense, income } },
    unknownAmount: 0,
  };
}

// ---- P2-1: 时间窗零命中回显生效窗口 + 放宽引导 ----
describe("buildFinanceSubsetZeroHitAnswer (P2-1)", () => {
  it("echoes the active window (phrase + span) for windowed zero-hit", () => {
    const md = buildFinanceSubsetZeroHitAnswer(["咖啡", "打车"], MAY, stats(3323, 3));
    expect(md).toContain("2026年5月");
    expect(md).toContain("2026-05-01 至 2026-05-31");
    expect(md).toContain("咖啡、打车");
    expect(md).toContain("没有找到记账记录");
  });
  it("offers a widening path with exact relaxed totals", () => {
    const md = buildFinanceSubsetZeroHitAnswer(["咖啡"], MAY, stats(3323, 3));
    expect(md).toContain("去掉时间限制后共有 3 笔支出");
    expect(md).toContain("¥3323");
  });
  it("says relaxed search also found nothing when zero overall", () => {
    const md = buildFinanceSubsetZeroHitAnswer(["咖啡"], MAY, stats(0, 0));
    expect(md).toContain("去掉时间限制后也没有找到");
    expect(md).toContain("换个关键词再问试试");
  });
  it("keeps the original wording exactly when no window applies", () => {
    const md = buildFinanceSubsetZeroHitAnswer(["咖啡"], null, null);
    expect(md).toBe(
      "按关键词「咖啡」精确匹配（标题/正文/标签）没有找到记账记录；为避免估算出错，我不做心算合计。如果你的记录用了别的说法（比如具体商品/商家名），换个关键词再问试试。"
    );
  });
});

// ---- P3-1: 主题词残片「相关/那天」剥净 ----
describe("trimTopicResidue additions (P3-1)", () => {
  it("strips 相关 from 「咖啡相关一共花了多少」", () => {
    expect(financeTopicTerms("咖啡相关一共花了多少")).toEqual(["咖啡"]);
  });
  it("strips 那天 from 「情人节那天花了多少」", () => {
    expect(financeTopicTerms("情人节那天花了多少钱")).toEqual(["情人节"]);
  });
  it("does not over-trim short terms", () => {
    expect(financeTopicTerms("打车一共花了多少")).toEqual(["打车"]);
  });
});

// ---- P3-2: 裸「N月份」时间窗解析（验证既有行为，锁回归）----
describe("bare month parsing (P3-2)", () => {
  it("parses 「5月份我花了多少」 as May of the current/most-recent year", () => {
    const now = new Date("2026-08-22T12:00:00Z");
    const r = parseTimeRange("5月份我花了多少", now);
    expect(r).not.toBeNull();
    expect(r!.phrase).toContain("5");
    expect(r!.start).toBe("2026-04-30 16:00:00");
    expect(r!.end).toBe("2026-05-31 16:00:00");
  });
});

// ---- P3-4: 英文分类名枚举路由 ----
describe("category enum topic (P3-4)", () => {
  it("maps English category names case-insensitively", () => {
    expect(enumTopicCategory("ideas")).toBe("idea");
    expect(enumTopicCategory("Ideas")).toBe("idea");
    expect(enumTopicCategory("todos")).toBe("todo");
    expect(enumTopicCategory("想法")).toBe("idea");
    expect(enumTopicCategory("книга")).toBeNull();
  });
  it("extracts 想法 topic from the Chinese rewrite of an English enum question", () => {
    expect(topicEnumIntent("我记录过哪些想法")).toBe("想法");
  });
  it("routes category-name topics deterministically without the LLM", async () => {
    const env = {
      AI: undefined,
      DEEPSEEK_API_KEY: undefined,
      DEEPSEEK_BASE_URL: undefined,
      AI_MODEL: undefined,
      AI_BASE_URL: undefined,
    } as never;
    const route = await resolveAskEnumIntent(env, "What ideas have I recorded?", "我记录过哪些想法");
    expect(route.topic).toBe("想法");
    expect(route.list).toBe(false);
  });
});

// ---- P3-5: 「平均每天花多少」日均口径 ----
describe("finance avg-per-day (P3-5)", () => {
  it("detects avg-per-day wording", () => {
    expect(FINANCE_AVG_PER_DAY_RE.test("这个月平均每天花多少钱")).toBe(true);
    expect(FINANCE_AVG_PER_DAY_RE.test("这个月花了多少钱")).toBe(false);
  });
  it("computes window days clamped to now", () => {
    const now = new Date("2026-08-22T12:00:00Z");
    expect(timeRangeAvgDays({ start: "2026-07-31 16:00:00", end: "2026-08-31 16:00:00", phrase: "这个月" }, now)).toBe(22);
    expect(timeRangeAvgDays({ start: "2026-06-30 16:00:00", end: "2026-07-31 16:00:00", phrase: "7月" }, now)).toBe(31);
    expect(timeRangeAvgDays(null, now)).toBeNull();
  });
  it("appends the per-day line to the aggregate answer", () => {
    const md = buildFinanceAggAnswer(stats(2200, 10), "这个月", 22);
    expect(md).toContain("按 22 天折算，平均每天支出 ¥100");
  });
  it("omits the per-day line without the avg limiter", () => {
    const md = buildFinanceAggAnswer(stats(2200, 10), "这个月");
    expect(md).not.toContain("平均每天");
  });
});
