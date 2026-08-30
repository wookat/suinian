// R296 P1-1~P1-4 / P2-6（audit-r295 §6）：财务时间窗四连修。
// - #14 跨年月份区间「2025年11月到2026年1月」成完整闭区间；
// - #8 「三月之前」是日历月上界，不是「三个月前」模糊窗、更不是关键词；
// - #15/#17 「今年到目前为止/到今天为止/不要算未来的」上界压到 now；
// - #4/#5 裸「X月」答案短语显式回写生效年份；
// - P2-6 「M月D日以后/之前」边界含/不含当日显式披露。
import { describe, it, expect } from "vitest";
import { parseTimeRange, isFinanceAggQuestion } from "../src/ask";
import { enumNoteLines } from "../src/index";
import type { NoteRow } from "../src/types";

// 2026-08-30 03:00 UTC = 2026-08-30 11:00 Asia/Shanghai（与 audit-r295 §6 同日）
const NOW = new Date("2026-08-30T03:00:00Z");

describe("R296 P1-1 跨年月份区间", () => {
  it("「2025年11月到2026年1月的收支」解析成完整闭区间", () => {
    const r = parseTimeRange("2025年11月到2026年1月的收支", NOW)!;
    expect(r.start).toBe("2025-10-31 16:00:00"); // 2025-11-01 00:00 +08:00
    expect(r.end).toBe("2026-01-31 16:00:00"); // 2026-02-01 00:00 +08:00（不含）
    expect(r.phrase).toBe("2025年11月至2026年1月");
  });

  it("同年区间「3月到5月」", () => {
    const r = parseTimeRange("3月到5月一共花了多少", NOW)!;
    expect(r.start).toBe("2026-02-28 16:00:00");
    expect(r.end).toBe("2026-05-31 16:00:00");
  });

  it("无年份的「11月到1月」按跨年闭区间（结束月 < 起始月 ⇒ 次年）", () => {
    const r = parseTimeRange("11月到1月的支出", NOW)!;
    expect(r.start).toBe("2025-10-31 16:00:00"); // 裸 11 月 >60 天未来 ⇒ 2025
    expect(r.end).toBe("2026-01-31 16:00:00");
  });

  it("日级区间「8月10号到8月20号」不被月份区间分支抢走", () => {
    const r = parseTimeRange("8月10号到8月20号之间买咖啡豆花了多少", NOW)!;
    expect(r.start).toBe("2026-08-09 16:00:00");
    expect(r.end).toBe("2026-08-20 16:00:00");
  });

  it("跨年区间问法仍走财务精确聚合路由", () => {
    expect(isFinanceAggQuestion("2025年11月到2026年1月的收支一共多少")).toBe(true);
  });
});

describe("R296 P1-2 「X月之前」成日历月上界", () => {
  it("「三月之前一共花了多少」上界=3月1日零点、起点开放", () => {
    const r = parseTimeRange("三月之前一共花了多少", NOW)!;
    expect(r.start).toBeNull();
    expect(r.end).toBe("2026-02-28 16:00:00"); // 2026-03-01 00:00 +08:00
    expect(r.phrase).toContain("2026年3月之前");
    expect(r.phrase).toContain("不含3月");
  });

  it("「三个月之前」仍是模糊回忆窗（带「个」）", () => {
    const r = parseTimeRange("三个月之前买的东西", NOW)!;
    expect(r.start).not.toBeNull();
    expect(r.end).not.toBeNull();
  });

  it("「12月之前」年份与裸「X月」同口径（>60 天未来 ⇒ 去年）并回写年份", () => {
    const r = parseTimeRange("12月之前花了多少", NOW)!;
    expect(r.end).toBe("2025-11-30 16:00:00"); // 2025-12-01 00:00 +08:00
    expect(r.phrase).toContain("2025年12月之前");
  });

  it("「X月之前」问法走财务精确聚合路由", () => {
    expect(isFinanceAggQuestion("三月之前一共花了多少")).toBe(true);
  });
});

describe("R296 P1-3 自然年窗上界压到 now", () => {
  it("「今年到目前为止一共花了多少」end=now", () => {
    const r = parseTimeRange("今年到目前为止一共花了多少", NOW)!;
    expect(r.start).toBe("2025-12-31 16:00:00"); // 2026-01-01 00:00 +08:00
    expect(r.end).toBe("2026-08-30 03:00:00");
    expect(r.phrase).toBe("今年至今");
  });

  it("「今年到今天为止的支出，不要算未来的」end=now（不被「今天」单日窗抢走）", () => {
    const r = parseTimeRange("今年到今天为止的支出，不要算未来的", NOW)!;
    expect(r.start).toBe("2025-12-31 16:00:00");
    expect(r.end).toBe("2026-08-30 03:00:00");
  });

  it("「今年一共花了多少，不要算未来的」end=now", () => {
    const r = parseTimeRange("今年一共花了多少，不要算未来的", NOW)!;
    expect(r.end).toBe("2026-08-30 03:00:00");
  });

  it("裸「今年」保持开放上界（未来计划类问答不受影响）", () => {
    const r = parseTimeRange("今年有什么计划", NOW)!;
    expect(r.end).toBeNull();
  });

  it("「今年到目前为止」问法走财务精确聚合路由", () => {
    expect(isFinanceAggQuestion("今年到目前为止一共花了多少")).toBe(true);
    expect(isFinanceAggQuestion("今年到今天为止的支出，不要算未来的")).toBe(true);
  });
});

describe("R296 P1-4 裸「X月」显式回写生效年份", () => {
  it("「12月花了多少」短语回写 2025 年", () => {
    const r = parseTimeRange("12月花了多少", NOW)!;
    expect(r.start).toBe("2025-11-30 16:00:00");
    expect(r.phrase).toBe("2025年12月");
  });

  it("「去年12月的收支」与裸「12月」窗口相同但短语不同", () => {
    const bare = parseTimeRange("12月花了多少", NOW)!;
    const lastYear = parseTimeRange("去年12月的收支", NOW)!;
    expect(bare.start).toBe(lastYear.start);
    expect(bare.phrase).not.toBe(lastYear.phrase);
  });

  it("「10月花了多少」（≤60 天临近未来月）回写 2026 年", () => {
    const r = parseTimeRange("10月花了多少", NOW)!;
    expect(r.phrase).toBe("2026年10月");
  });
});

describe("R296 P2-6 日边界披露", () => {
  it("「8月17日以后」含当日且短语披露", () => {
    const r = parseTimeRange("8月17日以后有哪些账", NOW)!;
    expect(r.start).toBe("2026-08-16 16:00:00"); // 2026-08-17 00:00 +08:00（含当日）
    expect(r.phrase).toContain("含当日");
    expect(r.phrase).toContain("2026年");
  });

  it("「10月5日之前」不含当日且短语披露", () => {
    const r = parseTimeRange("10月5日之前一共花了多少钱", NOW)!;
    expect(r.end).toBe("2026-10-04 16:00:00");
    expect(r.phrase).toContain("不含当日");
  });
});

describe("R296 枚举列举逐笔附金额（生产复测 #9「8月17日以后有哪些账」）", () => {
  const row = (over: Partial<NoteRow>): NoteRow =>
    ({
      id: "n1",
      title: "买椅子",
      content: "买椅子 610 元",
      created_at: "2026-08-17 03:00:00",
      category: "expense",
      is_sensitive: 0,
      amount: 610,
      currency: "CNY",
      ...over,
    }) as unknown as NoteRow;

  it("记账类笔记标题无金额时逐条附上底账金额", () => {
    const lines = enumNoteLines([
      row({}),
      row({ id: "n2", title: "卖旧书收入 300 元", category: "income", amount: 300 }),
      row({ id: "n3", title: "预付旅行团费", amount: 1200 }),
    ]);
    expect(lines[0]).toContain("买椅子（¥610）");
    // 标题已含金额的不重复附注
    expect(lines[1]).toContain("卖旧书收入 300 元");
    expect(lines[1]).not.toContain("¥300");
    expect(lines[2]).toContain("预付旅行团费（¥1200）");
  });

  it("非记账/敏感/无金额笔记不附金额", () => {
    const lines = enumNoteLines([
      row({ id: "n4", title: "买杯咖啡的想法", category: "idea", amount: 22 }),
      row({ id: "n5", is_sensitive: 1 }),
      row({ id: "n6", title: "记一笔", amount: null }),
    ]);
    expect(lines[0]).not.toContain("¥");
    expect(lines[1]).toContain("（加密的敏感笔记）");
    expect(lines[1]).not.toContain("¥");
    expect(lines[2]).not.toContain("¥");
  });
});
