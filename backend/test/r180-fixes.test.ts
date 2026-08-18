import { describe, expect, it } from "vitest";
import { isLedgerAggregateNote, buildFinanceExtremeAnswer } from "../src/ask";
import { collectSectionPrompt } from "../src/reports";

const LEDGER_CSV = "日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20";

// ---- P2-1 台账聚合金额污染主题极值（R179 审计）----

describe("isLedgerAggregateNote", () => {
  it("flags a multi-row ledger note whose amount equals the column sum", () => {
    expect(isLedgerAggregateNote({ content: LEDGER_CSV, amount: 356 })).toBe(true);
  });
  it("keeps a ledger note whose amount was hand-edited away from the sum", () => {
    expect(isLedgerAggregateNote({ content: LEDGER_CSV, amount: 300 })).toBe(false);
  });
  it("keeps ordinary single-expense notes", () => {
    expect(isLedgerAggregateNote({ content: "买了把键盘 458 元", amount: 458 })).toBe(false);
  });
  it("ignores notes without a recognized amount", () => {
    expect(isLedgerAggregateNote({ content: LEDGER_CSV, amount: null })).toBe(false);
  });
});

describe("buildFinanceExtremeAnswer ledger footnote", () => {
  const single = {
    id: "n1",
    title: "机械键盘",
    content: "买了把机械键盘 458 元",
    created_at: "2026-08-01 04:00:00",
    is_sensitive: 0,
    amount: 458,
    currency: "CNY",
  };
  it("notes excluded ledger aggregates in the caliber footnote", () => {
    const md = buildFinanceExtremeAnswer({ kind: "min", direction: "expense", rank: 1 }, [single], 0, null, ["键盘"], 1);
    expect(md).toContain("¥458");
    expect(md).toContain("1 条多行台账笔记的金额为多笔合计，未参与单笔比较");
  });
  it("answers deterministically when only ledger aggregates matched", () => {
    const md = buildFinanceExtremeAnswer({ kind: "min", direction: "expense", rank: 1 }, [], 0, null, ["键盘"], 1);
    expect(md).toContain("没有已识别出金额的单笔支出记录");
    expect(md).toContain("1 条多行台账笔记的金额为多笔合计");
  });
  it("omits the footnote when nothing was excluded", () => {
    const md = buildFinanceExtremeAnswer({ kind: "min", direction: "expense", rank: 1 }, [single], 0, null, ["键盘"]);
    expect(md).not.toContain("台账");
  });
});

// ---- P2-2 周报无收藏时不得编造收藏小节（R179 审计）----

describe("collectSectionPrompt", () => {
  it("asks for the favorites section when the period has collects", () => {
    const p = collectSectionPrompt(2);
    expect(p).toContain("值得回顾的收藏");
    expect(p).toContain("挑出值得再看的收藏");
  });
  it("forbids the favorites section when the period has no collects", () => {
    const p = collectSectionPrompt(0);
    expect(p).toContain("不要写「值得回顾的收藏」小节");
    expect(p).toContain("不要编造");
    expect(p).not.toContain("挑出值得再看的收藏");
  });
});
