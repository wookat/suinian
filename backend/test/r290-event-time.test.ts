import { describe, it, expect } from "vitest";
import {
  parseTimeRange,
  noteEventTime,
  inEventTimeRange,
  widenTimeRangeForEvents,
  financeCaliberAnswer,
  financeListIntent,
  financeListTopicTerms,
  financeAggIntent,
} from "../src/ask";

const NOW = new Date("2026-08-29T10:00:00Z");
const note = (content: string, created_at: string) => ({ title: null, content, created_at });

describe("R290 P1 财务时间窗按正文事件时间（audit-r289 §7）", () => {
  it("「3 月 10 日之前」解析为开放起点 + 该日零点终点，不再是当日单日窗", () => {
    const r = parseTimeRange("3 月 10 日之前一共花了多少钱？", NOW);
    expect(r?.start).toBeNull();
    expect(r?.end).toBe("2026-03-09 16:00:00"); // 上海 3-10 00:00
  });

  it("「3月下旬」解析为 21 日至月末", () => {
    const r = parseTimeRange("3月下旬有哪些支出？", NOW);
    expect(r?.start).toBe("2026-03-20 16:00:00");
    expect(r?.end).toBe("2026-03-31 16:00:00");
  });

  it("「3月上旬/中旬」分别为 1–10 / 11–20", () => {
    expect(parseTimeRange("3月上旬花了多少", NOW)?.end).toBe("2026-03-10 16:00:00");
    expect(parseTimeRange("3月中旬花了多少", NOW)?.start).toBe("2026-03-10 16:00:00");
  });

  it("正文事件日期优先于记录时间", () => {
    expect(noteEventTime(note("3月8日买了打印机 899 元", "2026-04-02 03:00:00"))).toBe("2026-03-08 04:00:00");
    expect(noteEventTime(note("2026-03-22 团队聚餐 460", "2026-08-01 03:00:00"))).toBe("2026-03-22 04:00:00");
    expect(noteEventTime(note("3月下旬出差报销 1200", "2026-04-02 03:00:00"))).toBe("2026-03-25 04:00:00");
  });

  // R290 生产实测漏面：仓库自身文案风格「3 月 8 日」带空格，抽取整条空转
  it("日期各段之间带空格同样抽取（「3 月 8 日」「3 月 下旬」「2026 - 03 - 08」）", () => {
    expect(noteEventTime(note("3 月 8 日聚餐花了 420 元（这条是 3 月下旬才补记的）。", "2026-08-29 12:00:00"))).toBe(
      "2026-03-08 04:00:00"
    );
    expect(noteEventTime(note("3 月 8 号买了打印机 899 元", "2026-04-02 03:00:00"))).toBe("2026-03-08 04:00:00");
    expect(noteEventTime(note("3 月 下旬出差报销 1200", "2026-04-02 03:00:00"))).toBe("2026-03-25 04:00:00");
    expect(noteEventTime(note("2026 年 3 月 22 日 团队聚餐 460", "2026-08-01 03:00:00"))).toBe("2026-03-22 04:00:00");
  });

  it("「M 月 D 日之前」「M 月下旬」是纯时间限定，不残留为财务关键词", () => {
    expect(financeListIntent("3 月 10 日之前有哪些支出？")).toBe("expense");
    expect(financeListIntent("3 月下旬有哪些支出？")).toBe("expense");
    expect(financeListTopicTerms("3 月下旬有哪些支出？")).toBeNull();
    expect(financeAggIntent("3 月 10 日之前一共花了多少钱？")).toBe("exact");
    expect(financeAggIntent("3 月下旬一共花了多少钱？")).toBe("exact");
  });

  it("正文无日期时回退记录时间", () => {
    expect(noteEventTime(note("买了咖啡 19 元", "2026-03-15 03:00:00"))).toBeNull();
    const r = parseTimeRange("3月花了多少", NOW)!;
    expect(inEventTimeRange(note("买了咖啡 19 元", "2026-03-15 03:00:00"), r)).toBe(true);
    expect(inEventTimeRange(note("买了咖啡 19 元", "2026-05-15 03:00:00"), r)).toBe(false);
  });

  it("事后补记（8 月记 3 月的事）落进 3 月窗", () => {
    const r = parseTimeRange("3月下旬有哪些支出？", NOW)!;
    expect(inEventTimeRange(note("3月22日 打车 45", "2026-08-10 01:00:00"), r)).toBe(true);
    expect(inEventTimeRange(note("3月2日 打车 45", "2026-08-10 01:00:00"), r)).toBe(false);
  });

  it("无年份日期按就近取年（比记录时间晚 60 天以上算去年）", () => {
    expect(noteEventTime(note("12月20日 年货 300", "2026-01-05 03:00:00"))).toBe("2025-12-20 04:00:00");
  });

  it("SQL 粗取窗按 ±400 天放宽", () => {
    const r = parseTimeRange("3月花了多少", NOW)!;
    const w = widenTimeRangeForEvents(r);
    expect(w.start! < r.start!).toBe(true);
    expect(w.end! > r.end!).toBe(true);
  });
});

describe("R290 P2 退款方向口径（audit-r289 §8）", () => {
  it("退款按支出冲减确定性作答，不答「算收入」", () => {
    const a = financeCaliberAnswer("退款算收入还是支出的冲减？");
    expect(a).not.toBeNull();
    expect(a!.startsWith("退款按「支出冲减」记，不算收入。")).toBe(true);
  });

  it("不劫持普通退款查询问法", () => {
    expect(financeCaliberAnswer("上个月的退款有哪些？")).toBeNull();
    expect(financeCaliberAnswer("这个月花了多少钱？")).toBeNull();
  });
});
