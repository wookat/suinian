import { describe, it, expect } from "vitest";
import {
  parseTimeRange,
  timeRangeDisplay,
  financeListIntent,
  financeTopicTerms,
  buildFinanceSubsetAnswer,
  financeAggIntent,
} from "../src/ask";

// 2026-08-08 07:00 UTC = 2026-08-08 15:00 Asia/Shanghai (Saturday)
const NOW = new Date("2026-08-08T07:00:00Z");

// ---- P2-1（audit-r249 §4.1）：绝对年月并入统一 parseTimeRange 管道 ----
describe("parseTimeRange absolute year (R250 P2-1)", () => {
  it("parses 2026年5月 as that calendar month", () => {
    const r = parseTimeRange("2026年5月我花了多少", NOW)!;
    expect(r.start).toBe("2026-04-30 16:00:00");
    expect(r.end).toBe("2026-05-31 16:00:00");
    expect(r.phrase).toBe("2026年5月");
  });

  it("parses 2025年12月 in a past year (no future-month year shifting)", () => {
    const r = parseTimeRange("2025年12月记了什么", NOW)!;
    expect(r.start).toBe("2025-11-30 16:00:00");
    expect(r.end).toBe("2025-12-31 16:00:00");
  });

  it("parses 二〇 style month numbers with absolute year (2026年十月)", () => {
    const r = parseTimeRange("2026年十月的记录", NOW)!;
    expect(r.start).toBe("2026-09-30 16:00:00");
    expect(r.end).toBe("2026-10-31 16:00:00");
  });

  it("parses bare 2025年 as the whole year window", () => {
    const r = parseTimeRange("2025年一共花了多少", NOW)!;
    expect(r.start).toBe("2024-12-31 16:00:00");
    expect(r.end).toBe("2025-12-31 16:00:00");
    expect(r.phrase).toBe("2025年");
  });

  it("parses 2026年第2季度 and 2025年Q4", () => {
    const q2 = parseTimeRange("2026年第2季度总共支出多少", NOW)!;
    expect(q2.start).toBe("2026-03-31 16:00:00");
    expect(q2.end).toBe("2026-06-30 16:00:00");
    const q4 = parseTimeRange("2025年Q4花了多少", NOW)!;
    expect(q4.start).toBe("2025-09-30 16:00:00");
    expect(q4.end).toBe("2025-12-31 16:00:00");
  });

  it("parses 2025年下半年 / 2026年上半年", () => {
    const h2 = parseTimeRange("2025年下半年我买了什么", NOW)!;
    expect(h2.start).toBe("2025-06-30 16:00:00");
    expect(h2.end).toBe("2025-12-31 16:00:00");
    const h1 = parseTimeRange("2026年上半年的支出", NOW)!;
    expect(h1.start).toBe("2025-12-31 16:00:00");
    expect(h1.end).toBe("2026-06-30 16:00:00");
  });

  it("parses concrete dates with absolute year (2025年8月10号到8月20号)", () => {
    const r = parseTimeRange("2025年8月10号到8月20号之间买咖啡豆花了多少", NOW)!;
    expect(r.start).toBe("2025-08-09 16:00:00");
    expect(r.end).toBe("2025-08-20 16:00:00");
    const single = parseTimeRange("2026年3月5日花了多少", NOW)!;
    expect(single.start).toBe("2026-03-04 16:00:00");
    expect(single.end).toBe("2026-03-05 16:00:00");
  });

  it("keeps the year in the display label (P3-1: no 「年3月」 truncation)", () => {
    const r = parseTimeRange("2026年3月的笔记有哪些", NOW)!;
    expect(r.phrase).toBe("2026年3月");
    expect(timeRangeDisplay(r)).toBe("2026-03-01 至 2026-03-31");
  });

  it("routes 2026年5月一共花了多少 into the exact finance aggregate", () => {
    expect(financeAggIntent("2026年5月一共花了多少钱")).toBe("exact");
    expect(financeAggIntent("2026年5月我花了多少？")).toBe("exact");
    expect(financeAggIntent("2025年总共支出多少")).toBe("exact");
  });

  it("does not treat phone-number-like digits as a year", () => {
    expect(parseTimeRange("电话13800年检提醒", NOW)).toBeNull();
  });
});

// ---- P2-2（audit-r249 §4.2）：历史时间窗动宾/裸列举收口财务列举管道 ----
describe("financeListIntent historical-window forms (R250 P2-2)", () => {
  it("routes 去年下半年我买了什么 as an expense list", () => {
    expect(financeListIntent("去年下半年我买了什么？")).toBe("expense");
    expect(financeListIntent("去年下半年买了哪些东西")).toBe("expense");
  });

  it("routes 去年下半年分别是哪几笔 as a both-direction list", () => {
    expect(financeListIntent("去年下半年分别是哪几笔？")).toBe("both");
    expect(financeListIntent("2025年下半年有哪几笔")).toBe("both");
  });

  it("keeps topic-qualified questions out of the pure list route", () => {
    expect(financeListIntent("去年下半年买了哪些书")).toBeNull();
    expect(financeListIntent("支出里最贵的是哪几笔")).toBeNull();
    expect(financeListIntent("超过80元的有哪几笔")).toBeNull();
  });
});

// ---- P2-3（audit-r249 §4.3）：双主题并列聚合 ----
describe("multi-topic subset aggregation (R250 P2-3)", () => {
  it("extracts both topics from 团队聚餐和团建各花了多少 (trailing 各 trimmed)", () => {
    expect(financeTopicTerms("团队聚餐和团建各花了多少？")).toEqual(["团队聚餐", "团建"]);
    expect(financeTopicTerms("买咖啡和买书分别花了多少钱")).toEqual(["咖啡", "买书"]);
  });

  const row = (over: Partial<Parameters<typeof buildFinanceSubsetAnswer>[1][number]>) => ({
    id: "n1",
    title: null,
    content: "",
    tags: "[]",
    created_at: "2026-08-01 04:00:00",
    category: "expense" as const,
    is_sensitive: 0,
    amount: 100,
    currency: "CNY",
    ...over,
  });

  it("answers each topic separately when both hit", () => {
    const md = buildFinanceSubsetAnswer(
      ["团队聚餐", "团建"],
      [
        row({ id: "a", title: "团队聚餐", content: "团队聚餐花了 300", amount: 300 }),
        row({ id: "b", title: "团建烧烤", content: "团建烧烤 260", amount: 260 }),
      ],
      null
    );
    expect(md).toContain("按主题拆分");
    expect(md).toContain("「团队聚餐」：1 笔，支出 ¥300");
    expect(md).toContain("「团建」：1 笔，支出 ¥260");
  });

  it("states partial coverage honestly when one topic has no hits", () => {
    const md = buildFinanceSubsetAnswer(
      ["团队聚餐", "滑板车"],
      [row({ id: "a", title: "团队聚餐", content: "团队聚餐花了 300", amount: 300 })],
      null
    );
    expect(md).toContain("「滑板车」：没有找到匹配的记账记录");
    expect(md).toContain("以上合计只包含已命中的主题");
  });

  it("keeps single-topic answers unchanged (no 拆分 section)", () => {
    const md = buildFinanceSubsetAnswer(["团建"], [row({ id: "b", title: "团建烧烤", content: "团建烧烤 260", amount: 260 })], null);
    expect(md).not.toContain("按主题拆分");
  });
});
