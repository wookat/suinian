// R292 P1-2（audit-r291 §财务时间窗）：事件时间口径收敛到唯一接入点
// eventTimeWindow，6 个窗口问法逐条锁死（跨年 / 无年份 / 带空格日期 /
// 上中下旬 / 之前 / 以后），并验证「SQL 粗取 + TS 精筛」成对语义。
import { describe, it, expect } from "vitest";
import { parseTimeRange, eventTimeWindow, financeAggIntent } from "../src/ask";

const NOW = new Date("2026-08-29T10:00:00Z");
const note = (content: string, created_at: string) => ({ title: null, content, created_at });

// 与生产同一批「事后补记」样本：正文事件日期与 created_at 分离。
const LEDGER = [
  note("2025年12月28日 年终聚餐 380 元", "2026-01-15 03:00:00"),
  note("1月3日 买键盘 299 元", "2026-02-20 03:00:00"),
  note("3 月 8 日聚餐花了 420 元（这条是 3 月下旬才补记的）。", "2026-08-01 12:00:00"),
  note("3月25日 出差报销 1200", "2026-05-02 03:00:00"),
  note("3月2日 打车 45", "2026-08-10 01:00:00"),
  note("买了咖啡 19 元", "2026-06-15 03:00:00"),
];

function hits(q: string): string[] {
  const range = parseTimeRange(q, NOW);
  expect(range, `${q} 未解析出时间窗`).not.toBeNull();
  const win = eventTimeWindow(range);
  return win.keep(LEDGER).map((n) => n.content);
}

describe("R292 P1-2 六个窗口问法逐条锁死（事件时间口径）", () => {
  it("跨年：「2025年12月花了多少」命中 12 月年终聚餐（1 月才补记）", () => {
    expect(hits("2025年12月花了多少")).toEqual(["2025年12月28日 年终聚餐 380 元"]);
  });

  it("无年份：「1月3日那笔多少钱」命中 2 月补记的 1 月 3 日键盘", () => {
    expect(hits("1月3日那笔多少钱")).toEqual(["1月3日 买键盘 299 元"]);
  });

  it("带空格日期：「3月8日花了多少」命中正文「3 月 8 日」的补记", () => {
    expect(hits("3月8日花了多少")).toEqual(["3 月 8 日聚餐花了 420 元（这条是 3 月下旬才补记的）。"]);
  });

  it("下旬：「3月下旬花了多少」命中 3 月 25 日报销，排除 3 月 2 日与 3 月 8 日", () => {
    expect(hits("3月下旬花了多少")).toEqual(["3月25日 出差报销 1200"]);
  });

  it("之前：「3月8日之前花了多少」命中 12 月/1 月/3 月 2 日，不含 3 月 8 日当日", () => {
    expect(hits("3月8日之前花了多少")).toEqual([
      "2025年12月28日 年终聚餐 380 元",
      "1月3日 买键盘 299 元",
      "3月2日 打车 45",
    ]);
  });

  it("以后：「3月8日以后花了多少」命中 3 月 8 日当日及以后 + 无日期正文按记录时间", () => {
    expect(hits("3月8日以后花了多少")).toEqual([
      "3 月 8 日聚餐花了 420 元（这条是 3 月下旬才补记的）。",
      "3月25日 出差报销 1200",
      "买了咖啡 19 元",
    ]);
  });

  it("六个问法全部是财务精确合计意图（不落 fail-closed）", () => {
    for (const q of [
      "2025年12月花了多少",
      "1月3日那笔多少钱",
      "3月8日花了多少",
      "3月下旬花了多少",
      "3月8日之前花了多少",
      "3月8日以后花了多少",
    ]) {
      expect(financeAggIntent(q), q).not.toBe("fail_closed");
    }
  });
});

describe("R292 P1-2 eventTimeWindow：SQL 粗取 + TS 精筛成对语义", () => {
  it("SQL 侧窗放宽 ±400 天，TS 侧按原窗精筛", () => {
    const r = parseTimeRange("3月花了多少", NOW)!;
    const win = eventTimeWindow(r);
    expect(win.sql!.start! < r.start!).toBe(true);
    expect(win.sql!.end! > r.end!).toBe(true);
    expect(win.count(LEDGER)).toBe(3);
  });

  it("无时间限定时不加 SQL 条件、keep 恒等", () => {
    const win = eventTimeWindow(null);
    const conds: string[] = [];
    const binds: unknown[] = [];
    win.applySql(conds, binds);
    expect(conds).toEqual([]);
    expect(binds).toEqual([]);
    expect(win.keep(LEDGER)).toEqual(LEDGER);
  });
});
