import { describe, it, expect } from "vitest";
import { parseTimeRange, inTimeRange, isRefusalAnswer, buildNoAnswerResponse } from "../src/ask";

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
});
