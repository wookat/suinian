import { describe, it, expect } from "vitest";
import { parseTimeRange, inTimeRange, timeRangeDisplay, buildTimeWindowNoAnswerResponse, isRefusalAnswer, buildNoAnswerResponse, sensitiveHintLine } from "../src/ask";

// 2026-08-08 07:00 UTC = 2026-08-08 15:00 Asia/Shanghai (Saturday)
const NOW = new Date("2026-08-08T07:00:00Z");

describe("parseTimeRange", () => {
  it("returns null when the question has no time phrase", () => {
    expect(parseTimeRange("咖啡馆的点子是什么", NOW)).toBeNull();
    expect(parseTimeRange("上次说的那个方案", NOW)).toBeNull();
  });

  it("parses 今天 / 昨天 / 前天 (Shanghai day boundaries in UTC)", () => {
    const today = parseTimeRange("今天记了什么", NOW)!;
    expect(today.start).toBe("2026-08-07 16:00:00"); // 2026-08-08 00:00 +08:00
    expect(today.end).toBeNull();
    const yesterday = parseTimeRange("昨天买了什么", NOW)!;
    expect(yesterday.start).toBe("2026-08-06 16:00:00");
    expect(yesterday.end).toBe("2026-08-07 16:00:00");
    const dby = parseTimeRange("前天的笔记", NOW)!;
    expect(dby.start).toBe("2026-08-05 16:00:00");
    expect(dby.end).toBe("2026-08-06 16:00:00");
  });

  it("parses 最近一周 / 最近3天 rolling windows", () => {
    const week = parseTimeRange("最近一周我花了哪些钱", NOW)!;
    expect(week.start).toBe("2026-07-31 16:00:00");
    expect(week.end).toBeNull();
    const d3 = parseTimeRange("最近3天记了什么", NOW)!;
    expect(d3.start).toBe("2026-08-04 16:00:00");
  });

  it("parses 本周 (since Monday) and 上周 (previous Mon..Sun)", () => {
    // 2026-08-08 is Saturday → Monday is 08-03
    const thisWeek = parseTimeRange("本周的待办", NOW)!;
    expect(thisWeek.start).toBe("2026-08-02 16:00:00");
    const lastWeek = parseTimeRange("上周去哪了", NOW)!;
    expect(lastWeek.start).toBe("2026-07-26 16:00:00");
    expect(lastWeek.end).toBe("2026-08-02 16:00:00");
  });

  it("parses 本月 and 上个月 calendar months", () => {
    const thisMonth = parseTimeRange("这个月的支出", NOW)!;
    expect(thisMonth.start).toBe("2026-07-31 16:00:00");
    const lastMonth = parseTimeRange("上个月我为什么觉得方案A不行", NOW)!;
    expect(lastMonth.start).toBe("2026-06-30 16:00:00");
    expect(lastMonth.end).toBe("2026-07-31 16:00:00");
  });

  it("parses fuzzy 两个多月前 as a window around that time", () => {
    const r = parseTimeRange("两个多月前我开始学什么", NOW)!;
    // center 60 days ago (≈06-09), window ±20 days
    expect(r.start).toBe("2026-05-19 16:00:00");
    expect(r.end).toBe("2026-06-28 16:00:00");
  });

  it("parses 去年 and bare month like 6月", () => {
    const ly = parseTimeRange("去年的总结", NOW)!;
    expect(ly.start).toBe("2024-12-31 16:00:00");
    expect(ly.end).toBe("2025-12-31 16:00:00");
    const june = parseTimeRange("6月的记录", NOW)!;
    expect(june.start).toBe("2026-05-31 16:00:00");
    expect(june.end).toBe("2026-06-30 16:00:00");
    // a future bare month refers to last year
    const dec = parseTimeRange("12月去哪玩了", NOW)!;
    expect(dec.start).toBe("2025-11-30 16:00:00");
  });

  it("does not misread 上个月 as a bare month or 半年 as a month number", () => {
    const r = parseTimeRange("上个月的电费", NOW)!;
    expect(r.phrase).toBe("上个月");
    expect(parseTimeRange("半年前的事", NOW)).toBeNull();
  });

  // R246 F-5（audit-r245）：季度窗
  it("parses relative quarters 上个季度 / 本季度 / 上一季度", () => {
    // NOW is 2026-08-08 → Q3 2026; 上个季度 = Q2 2026
    const prev = parseTimeRange("上个季度我看了什么电影", NOW)!;
    expect(prev.start).toBe("2026-03-31 16:00:00"); // 2026-04-01 00:00 +08:00
    expect(prev.end).toBe("2026-06-30 16:00:00"); // 2026-07-01 00:00 +08:00
    expect(prev.phrase).toBe("上个季度");
    const prev2 = parseTimeRange("上一季度的支出", NOW)!;
    expect(prev2.start).toBe(prev.start);
    const cur = parseTimeRange("本季度记了什么", NOW)!;
    expect(cur.start).toBe("2026-06-30 16:00:00");
    expect(cur.end).toBeNull();
  });
  it("parses 上个季度 across a year boundary", () => {
    // 2026-02-10 is Q1 → 上个季度 = Q4 2025
    const r = parseTimeRange("上个季度的账单", new Date("2026-02-10T07:00:00Z"))!;
    expect(r.start).toBe("2025-09-30 16:00:00");
    expect(r.end).toBe("2025-12-31 16:00:00");
  });
  it("parses absolute quarters 第三季度 / 一季度 / Q2, future quarter falls to last year", () => {
    const q3 = parseTimeRange("第三季度花了多少", NOW)!;
    expect(q3.start).toBe("2026-06-30 16:00:00");
    expect(q3.end).toBe("2026-09-30 16:00:00");
    const q1 = parseTimeRange("一季度的记录", NOW)!;
    expect(q1.start).toBe("2025-12-31 16:00:00");
    const q2en = parseTimeRange("Q2 花了多少钱", NOW)!;
    expect(q2en.start).toBe("2026-03-31 16:00:00");
    // Q4 尚未到 → 去年 Q4（与裸「X月」同口径）
    const q4 = parseTimeRange("第四季度去哪玩了", NOW)!;
    expect(q4.start).toBe("2025-09-30 16:00:00");
    expect(q4.end).toBe("2025-12-31 16:00:00");
    const lyq2 = parseTimeRange("去年第二季度的支出", NOW)!;
    expect(lyq2.start).toBe("2025-03-31 16:00:00");
    expect(lyq2.end).toBe("2025-06-30 16:00:00");
  });
  it("parses 上半年 / 下半年 / 去年下半年 calendar halves", () => {
    const h1 = parseTimeRange("上半年一共花了多少", NOW)!;
    expect(h1.start).toBe("2025-12-31 16:00:00");
    expect(h1.end).toBe("2026-06-30 16:00:00");
    const h2 = parseTimeRange("下半年的计划", NOW)!; // now is Aug → this year's H2
    expect(h2.start).toBe("2026-06-30 16:00:00");
    expect(h2.end).toBe("2026-12-31 16:00:00");
    const lyH2 = parseTimeRange("去年下半年去了哪些城市", NOW)!;
    expect(lyH2.start).toBe("2025-06-30 16:00:00");
    expect(lyH2.end).toBe("2025-12-31 16:00:00");
    // 上半年问「下半年」指去年下半年
    const early = parseTimeRange("下半年的开销", new Date("2026-03-10T07:00:00Z"))!;
    expect(early.start).toBe("2025-06-30 16:00:00");
    expect(early.end).toBe("2025-12-31 16:00:00");
  });

  // R246 F-6（audit-r245）：「今年X月」不再被宽泛「今年」吞掉
  it("parses 今年X月 / 去年X月 as that specific month", () => {
    const feb = parseTimeRange("今年2月我去了哪里", NOW)!;
    expect(feb.start).toBe("2026-01-31 16:00:00");
    expect(feb.end).toBe("2026-02-28 16:00:00");
    expect(feb.phrase).toContain("2月");
    const june = parseTimeRange("今年六月公司团建去了哪里", NOW)!;
    expect(june.start).toBe("2026-05-31 16:00:00");
    expect(june.end).toBe("2026-06-30 16:00:00");
    const lyNov = parseTimeRange("去年11月的支出", NOW)!;
    expect(lyNov.start).toBe("2025-10-31 16:00:00");
    expect(lyNov.end).toBe("2025-11-30 16:00:00");
  });
  it("does not let 一共/合计 after 今年X月 break the month window (R246 prod QA)", () => {
    const r = parseTimeRange("今年8月一共花了多少钱", NOW)!;
    expect(r.phrase).toBe("今年8月");
    expect(r.start).toBe("2026-07-31 16:00:00");
    expect(r.end).toBe("2026-08-31 16:00:00");
    const cjk = parseTimeRange("今年八月一共花了多少", NOW)!;
    expect(cjk.start).toBe("2026-07-31 16:00:00");
  });
  it("keeps 今年8月10号 (explicit day) out of the year-month branch", () => {
    const r = parseTimeRange("今年8月10号买了什么", NOW)!;
    // 不误窄化成整月窗：维持现状（整年窗或后续日期分支）
    expect(r.phrase).not.toBe("今年8月");
  });
  it("still parses bare 今年 / 去年 as whole years", () => {
    expect(parseTimeRange("今年记了多少条", NOW)!.phrase).toBe("今年");
    expect(parseTimeRange("去年的总结", NOW)!.phrase).toBe("去年");
  });
});

describe("inTimeRange", () => {
  const range = { start: "2026-07-01 00:00:00", end: "2026-08-01 00:00:00", phrase: "上个月" };
  it("checks inclusive start / exclusive end", () => {
    expect(inTimeRange("2026-07-01 00:00:00", range)).toBe(true);
    expect(inTimeRange("2026-07-15 12:00:00", range)).toBe(true);
    expect(inTimeRange("2026-08-01 00:00:00", range)).toBe(false);
    expect(inTimeRange("2026-06-30 23:59:59", range)).toBe(false);
  });
  it("treats null bounds as unbounded", () => {
    expect(inTimeRange("2020-01-01 00:00:00", { start: null, end: null, phrase: "" })).toBe(true);
  });
});

describe("isRefusalAnswer", () => {
  it("detects citation-less 没找到 answers", () => {
    expect(isRefusalAnswer("没找到。")).toBe(true);
    expect(isRefusalAnswer("笔记里没有找到相关信息。")).toBe(true);
    expect(isRefusalAnswer("没有相关记录，建议换个说法。")).toBe(true);
  });
  it("never flags answers that cite notes", () => {
    expect(isRefusalAnswer("没找到电费，但 [2] 提到房租。")).toBe(false);
    expect(isRefusalAnswer("根据 [1]，你决定改游泳。")).toBe(false);
  });
  it("ignores normal answers", () => {
    expect(isRefusalAnswer("你上个月觉得方案A依赖太多外部接口。")).toBe(false);
  });
});

describe("buildNoAnswerResponse", () => {
  it("suggests up to 3 nearby notes as references", () => {
    const notes = [
      { id: "a", title: "咖啡馆新思路", content: "x" },
      { id: "b", title: null, content: "买了双跑鞋 549 元，结果现在改游泳了" },
      { id: "c", title: "t3", content: "x" },
      { id: "d", title: "t4", content: "x" },
    ];
    const { answer, references } = buildNoAnswerResponse(notes);
    expect(answer).toContain("没找到相关笔记");
    expect(answer).toContain("咖啡馆新思路");
    expect(references).toEqual([
      { index: 1, note_id: "a" },
      { index: 2, note_id: "b" },
      { index: 3, note_id: "c" },
    ]);
  });
  it("gives rephrase guidance when there is nothing nearby", () => {
    const { answer, references } = buildNoAnswerResponse([]);
    expect(answer).toContain("没找到相关笔记");
    expect(answer).toContain("换个说法");
    expect(references).toEqual([]);
  });
  it("says the notes don't mention it (not 没找到) when recall did hit topic notes", () => {
    const notes = [{ id: "a", title: "体检记录", content: "x" }];
    const { answer, references } = buildNoAnswerResponse(notes, "not_in_notes");
    expect(answer).not.toContain("没找到相关笔记");
    expect(answer).toContain("没有提到");
    expect(answer).toContain("体检记录");
    expect(references).toEqual([{ index: 1, note_id: "a" }]);
  });
});

describe("timeRangeDisplay", () => {
  it("renders bounded ranges as Shanghai local dates (end exclusive → last day)", () => {
    expect(
      timeRangeDisplay({ start: "2026-07-26 16:00:00", end: "2026-08-02 16:00:00", phrase: "上周" })
    ).toBe("2026-07-27 至 2026-08-02");
  });
  it("renders open-ended ranges", () => {
    expect(timeRangeDisplay({ start: "2026-07-31 16:00:00", end: null, phrase: "最近一周" })).toBe(
      "2026-08-01 至今"
    );
    expect(timeRangeDisplay({ start: null, end: "2026-08-02 16:00:00", phrase: "" })).toBe(
      "截至 2026-08-02"
    );
  });
  it("collapses a single-day range", () => {
    expect(
      timeRangeDisplay({ start: "2026-08-06 16:00:00", end: "2026-08-07 16:00:00", phrase: "昨天" })
    ).toBe("2026-08-07");
  });
});

describe("buildTimeWindowNoAnswerResponse (R244 P2 F-1)", () => {
  const range = { start: "2026-07-26 16:00:00", end: "2026-08-02 16:00:00", phrase: "上周" };
  it("refuses honestly with the window spelled out when nothing is out of range either", () => {
    const { answer, references } = buildTimeWindowNoAnswerResponse(range, []);
    expect(answer).toContain("上周");
    expect(answer).toContain("范围内没有找到相关记录");
    expect(references).toEqual([]);
  });
  it("lists out-of-range hits only as dated, clearly-labeled suggestions", () => {
    const notes = [
      { id: "a", title: "成都出差台账", content: "打车,45", created_at: "2026-07-13 03:00:00" },
      { id: "b", title: null, content: "买了双跑鞋 549 元", created_at: "2026-06-30 03:00:00" },
      { id: "c", title: "t3", content: "x", created_at: "2026-06-01 03:00:00" },
      { id: "d", title: "t4", content: "x", created_at: "2026-05-01 03:00:00" },
    ];
    const { answer, references } = buildTimeWindowNoAnswerResponse(range, notes);
    expect(answer).toContain("范围内没有找到相关记录");
    expect(answer).toContain("不在这个时间范围内");
    expect(answer).toContain("2026-07-13");
    expect(answer).toContain("成都出差台账");
    // 绝不把范围外内容写成窗内事实
    expect(answer).not.toMatch(/上周.*去了成都/);
    expect(references).toEqual([
      { index: 1, note_id: "a" },
      { index: 2, note_id: "b" },
      { index: 3, note_id: "c" },
    ]);
  });
  it("reads as a refusal to the answer-quality gates", () => {
    const { answer } = buildTimeWindowNoAnswerResponse(range, []);
    expect(isRefusalAnswer(answer)).toBe(true);
  });
});

describe("sensitiveHintLine", () => {
  it("is empty when there are no sensitive hits", () => {
    expect(sensitiveHintLine(0, ["密码"])).toBe("");
    expect(sensitiveHintLine(-1, ["密码"])).toBe("");
  });
  it("points to timeline search with the query keywords, exposing only a count", () => {
    const hint = sensitiveHintLine(2, ["银行卡", "密码"]);
    expect(hint).toContain("2 条加密的敏感笔记");
    expect(hint).toContain("搜索「银行卡 密码」");
    expect(hint).toContain("解锁");
  });
  it("falls back to generic wording when no usable keyword", () => {
    expect(sensitiveHintLine(1, [])).toContain("搜索相关关键词");
  });
});
