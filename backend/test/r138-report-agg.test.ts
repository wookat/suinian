import { describe, it, expect } from "vitest";
import { financeStatsFromAgg, categoryCountsFromAgg, type PeriodAggRow } from "../src/reports";

function row(p: Partial<PeriodAggRow>): PeriodAggRow {
  return { category: "idea", currency: "CNY", cnt: 0, sensitive: 0, todo_done_cnt: 0, amount_total: 0, unknown_amount: 0, ...p };
}

describe("R138 report SQL aggregates", () => {
  it("finance totals cover multiple currencies and count unknown amounts separately", () => {
    const rows = [
      row({ category: "expense", currency: "CNY", cnt: 1200, amount_total: 56789.5, unknown_amount: 3 }),
      row({ category: "expense", currency: "USD", cnt: 4, amount_total: 120 }),
      row({ category: "income", currency: "CNY", cnt: 10, amount_total: 30000 }),
      row({ category: "transfer", currency: "CNY", cnt: 5 }),
      row({ category: "idea", cnt: 900 }),
    ];
    const s = financeStatsFromAgg(rows);
    expect(s.expenseCount).toBe(1204);
    expect(s.incomeCount).toBe(10);
    expect(s.transferCount).toBe(5);
    expect(s.unknownAmount).toBe(3);
    expect(s.totals.CNY).toEqual({ expense: 56789.5, income: 30000 });
    expect(s.totals.USD).toEqual({ expense: 120, income: 0 });
  });

  it("expense rows where every amount is unknown contribute no currency total", () => {
    const s = financeStatsFromAgg([row({ category: "expense", currency: "JPY", cnt: 2, unknown_amount: 2 })]);
    expect(s.expenseCount).toBe(2);
    expect(s.unknownAmount).toBe(2);
    expect(s.totals.JPY).toBeUndefined();
  });

  it("category counts sum across currencies and keep the authoritative total beyond any display LIMIT", () => {
    const rows = [
      row({ category: "expense", currency: "CNY", cnt: 800, sensitive: 2 }),
      row({ category: "expense", currency: "USD", cnt: 400 }),
      row({ category: "idea", cnt: 500, sensitive: 1 }),
    ];
    const { total, counts, sensitive } = categoryCountsFromAgg(rows);
    expect(total).toBe(1700);
    expect(counts.get("expense")).toBe(1200);
    expect(counts.get("idea")).toBe(500);
    expect(sensitive).toBe(3);
  });
});
