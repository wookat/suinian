import { describe, it, expect } from "vitest";
import { parseTimeRange, eventTimeWindow, inEventTimeRange, futureEventNotes } from "../src/ask";
import { financeStats } from "../src/reports";
import type { NoteRow } from "../src/types";

/**
 * R298 P1-1（audit-r297 §5）：未来日期的记账不得并入当期（今天/本周/本月），
 * 否则同一笔在问「9月/12月」时又各自出现一次 = 重复计入。
 */
const NOW = new Date("2026-08-30T04:00:00Z"); // 上海 2026-08-30 12:00

const note = (id: string, content: string, createdAt: string, amount: number): NoteRow =>
  ({
    id,
    user_id: "u",
    title: null,
    content,
    created_at: createdAt,
    category: "expense",
    amount,
    currency: "CNY",
    is_sensitive: 0,
    tags: null,
    deleted_at: null,
  }) as unknown as NoteRow;

// R297 §5 复现底账：今天真实 ¥66，未来三笔 720 + 1200 + 340 被并入答成 ¥2326。
const TODAY = note("n-today", "午饭 66 元", "2026-08-30 03:00:00", 66);
const FUTURE = [
  note("n-0915", "9月15日 房租 720 元", "2026-08-30 03:10:00", 720),
  note("n-1010", "10月10日 机票 1200 元", "2026-08-30 03:11:00", 1200),
  // 无年份的「12月24日」按 ±60 天就近口径会解到去年，故显式写年份。
  note("n-1224", "2026年12月24日 礼物 340 元", "2026-08-30 03:12:00", 340),
];
const ROWS = [TODAY, ...FUTURE];

describe("R298 P1-1 未来记账不并入当期", () => {
  for (const phrase of ["今天", "本周", "本月"]) {
    it(`${phrase}：排除未来记账并披露笔数`, () => {
      const range = parseTimeRange(`${phrase}一共花了多少钱`, NOW)!;
      expect(range.excludeFuture).toBe(true);
      const win = eventTimeWindow(range);
      const kept = win.keep(ROWS);
      expect(kept.map((n) => n.id)).toEqual(["n-today"]);
      expect(win.futureExcluded(ROWS)).toBe(3);
      expect(financeStats(kept).totals.CNY.expense).toBe(66);
    });
  }

  it("未来月份单问仍正确（不因当期排除而丢失）", () => {
    for (const [q, id, amount] of [
      ["9月一共花了多少", "n-0915", 720],
      ["10月花了多少", "n-1010", 1200],
      ["今年12月花了多少", "n-1224", 340],
    ] as const) {
      const range = parseTimeRange(q, NOW)!;
      expect(range.excludeFuture).toBeFalsy();
      const kept = eventTimeWindow(range).keep(ROWS);
      expect(kept.map((n) => n.id)).toEqual([id]);
      expect(financeStats(kept).totals.CNY.expense).toBe(amount);
    }
  });

  it("过去窗与显式上界窗不受影响", () => {
    for (const q of ["昨天花了多少", "上个月花了多少", "今年到目前为止花了多少", "最近7天花了多少"]) {
      expect(parseTimeRange(q, NOW)!.excludeFuture).toBeFalsy();
    }
  });

  it("同一笔不会既算当期又算所属月份（重复计入回归）", () => {
    const cur = eventTimeWindow(parseTimeRange("本月花了多少", NOW)!).keep(ROWS);
    const sep = eventTimeWindow(parseTimeRange("9月花了多少", NOW)!).keep(ROWS);
    expect(cur.some((n) => sep.some((s) => s.id === n.id))).toBe(false);
  });

  it("futureEventNotes 只在当期窗返回未来笔记", () => {
    expect(futureEventNotes(ROWS, parseTimeRange("本月花了多少", NOW), NOW).map((n) => n.id)).toEqual([
      "n-0915",
      "n-1010",
      "n-1224",
    ]);
    expect(futureEventNotes(ROWS, parseTimeRange("上个月花了多少", NOW), NOW)).toEqual([]);
    expect(inEventTimeRange(FUTURE[0], parseTimeRange("本月花了多少", NOW)!, NOW)).toBe(false);
  });
});
