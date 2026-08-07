import { describe, it, expect } from "vitest";
import { parseTriageJson, buildTriagePrompt } from "../src/triage";
import {
  lastMonthRange,
  thisMonthRange,
  financeStats,
  financeSection,
  formatAmount,
} from "../src/reports";
import type { NoteRow } from "../src/types";

describe("triage expense/income parsing", () => {
  it("parses an expense with amount + currency + merchant", () => {
    const r = parseTriageJson(
      '{"category":"expense","tags":["餐饮"],"title":"午饭","is_sensitive":false,"amount":23,"currency":"cny","merchant":"黄焖鸡"}'
    );
    expect(r?.category).toBe("expense");
    expect(r?.amount).toBe(23);
    expect(r?.currency).toBe("CNY");
    expect(r?.merchant).toBe("黄焖鸡");
  });

  it("parses an income and defaults currency to CNY when amount is present", () => {
    const r = parseTriageJson('{"category":"income","tags":[],"title":"报销到账","is_sensitive":false,"amount":1200}');
    expect(r?.category).toBe("income");
    expect(r?.amount).toBe(1200);
    expect(r?.currency).toBe("CNY");
  });

  it("keeps amount null when the model is uncertain (never guesses)", () => {
    const r = parseTriageJson('{"category":"expense","tags":["咖啡"],"title":"买咖啡","is_sensitive":false,"amount":null}');
    expect(r?.category).toBe("expense");
    expect(r?.amount).toBeNull();
    expect(r?.currency).toBeNull();
  });

  it("rejects bogus amounts (negative / NaN / non-number)", () => {
    expect(parseTriageJson('{"category":"expense","tags":[],"title":"t","is_sensitive":false,"amount":-5}')?.amount).toBeNull();
    expect(parseTriageJson('{"category":"expense","tags":[],"title":"t","is_sensitive":false,"amount":"23元"}')?.amount).toBeNull();
  });

  it("ignores amount on non-finance categories", () => {
    const r = parseTriageJson('{"category":"idea","tags":[],"title":"t","is_sensitive":false,"amount":100,"currency":"CNY"}');
    expect(r?.amount).toBeNull();
    expect(r?.currency).toBeNull();
  });

  it("normalizes uppercase USD and caps merchant length", () => {
    const r = parseTriageJson(
      `{"category":"expense","tags":[],"title":"t","is_sensitive":false,"amount":9.99,"currency":"usd","merchant":"${"很".repeat(40)}"}`
    );
    expect(r?.currency).toBe("USD");
    expect(r?.merchant?.length).toBe(24);
  });

  it("prompt mentions expense/income with no-guessing rule", () => {
    const p = buildTriagePrompt(new Date("2026-08-07T00:00:00Z"));
    expect(p).toContain('"expense"');
    expect(p).toContain('"income"');
    expect(p).toContain("绝不要猜");
  });
});

const fin = (category: "expense" | "income", amount: number | null, currency: string | null = "CNY"): NoteRow =>
  ({ category, amount, currency, is_sensitive: 0 }) as unknown as NoteRow;

describe("financeStats / financeSection", () => {
  it("sums per currency and counts unknown amounts", () => {
    const stats = financeStats([
      fin("expense", 23),
      fin("expense", 12.5),
      fin("income", 1200),
      fin("expense", 9.99, "USD"),
      fin("expense", null, null),
      { category: "idea", amount: null, currency: null, is_sensitive: 0 } as unknown as NoteRow,
    ]);
    expect(stats.expenseCount).toBe(4);
    expect(stats.incomeCount).toBe(1);
    expect(stats.totals.CNY).toEqual({ expense: 35.5, income: 1200 });
    expect(stats.totals.USD).toEqual({ expense: 9.99, income: 0 });
    expect(stats.unknownAmount).toBe(1);
    const md = financeSection(stats);
    expect(md).toContain("收支合计");
    expect(md).toContain("4 笔支出、1 笔收入");
    expect(md).toContain("¥35.50");
    expect(md).toContain("$9.99");
    expect(md).toContain("1 笔未识别出金额");
  });

  it("returns empty section when there are no finance notes", () => {
    expect(financeSection(financeStats([]))).toBe("");
  });

  it("formats integer amounts without decimals", () => {
    expect(formatAmount(1200, "CNY")).toBe("¥1200");
    expect(formatAmount(12.5, "CNY")).toBe("¥12.50");
    expect(formatAmount(3, "SEK")).toBe("3 SEK");
  });
});

describe("month ranges (Asia/Shanghai)", () => {
  it("lastMonthRange covers the full previous calendar month", () => {
    // 2026-08-01 04:00 Shanghai (2026-07-31 20:00 UTC)
    const r = lastMonthRange(new Date("2026-08-01T04:00:00+08:00"));
    expect(r).toEqual({ monthStart: "2026-07-01", monthEnd: "2026-07-31" });
  });

  it("handles January -> December of previous year", () => {
    const r = lastMonthRange(new Date("2026-01-15T12:00:00+08:00"));
    expect(r).toEqual({ monthStart: "2025-12-01", monthEnd: "2025-12-31" });
  });

  it("thisMonthRange runs 1st..today", () => {
    const r = thisMonthRange(new Date("2026-08-07T12:00:00+08:00"));
    expect(r).toEqual({ monthStart: "2026-08-01", monthEnd: "2026-08-07" });
  });

  it("handles leap February end", () => {
    const r = lastMonthRange(new Date("2028-03-05T12:00:00+08:00"));
    expect(r).toEqual({ monthStart: "2028-02-01", monthEnd: "2028-02-29" });
  });
});
