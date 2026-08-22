// R256（audit-r255）：P1-1 关系限定词忠实性护栏 + P2×3（并列聚合/双窗对比/
// 列举主题限定）+ P3-1 单字主题 + P3-2 品类归纳 + P3-3 仅标签命中口径。
import { describe, it, expect } from "vitest";
import {
  ungroundedRelationTerm,
  buildNoAnswerResponse,
  financeAggIntent,
  financeDualWindowIntent,
  financeListIntent,
  financeListFollowUpIntent,
  financeListTopicTerms,
  financeTopicTerms,
  filterSingleCharTopicRows,
  expenseFacetIntent,
  buildExpenseFacetAnswer,
} from "../src/ask";
import type { NoteRow } from "../src/types";

describe("R256 fix: 列举追问方向不被上一轮收支口径覆盖", () => {
  const aggAnswer = "本月：支出 ¥546（5 笔），收入 ¥8000（1 笔）。口径与周报/月报一致";
  it("「收到过哪些钱」在合计答案后仍是收入方向，不继承 both", () => {
    expect(financeListFollowUpIntent("收到过哪些钱", aggAnswer)).toBe("income");
    expect(financeListFollowUpIntent("收了哪几笔", aggAnswer)).toBe("income");
  });
  it("无方向词的裸列举追问仍继承 both", () => {
    expect(financeListFollowUpIntent("分别是哪几笔", aggAnswer)).toBe("both");
  });
});

function row(over: Partial<NoteRow>): NoteRow {
  return {
    id: "n1",
    user_id: "u1",
    content: "内容",
    title: null,
    category: "expense",
    tags: null,
    source: "api",
    created_at: "2026-04-06 04:00:00",
    updated_at: "2026-04-06 04:00:00",
    deleted_at: null,
    is_sensitive: 0,
    amount: 100,
    currency: "CNY",
    ...over,
  } as NoteRow;
}

describe("ungroundedRelationTerm (P1-1)", () => {
  const bookSource = "买了本《长安的荔枝》45 元\n买了本《置身事内》52 元\n购物,读书";

  it("flags 女朋友 when no synonym appears in recalled sources", () => {
    expect(ungroundedRelationTerm("我给女朋友买过什么礼物", bookSource)).toBe("女朋友");
  });

  it("accepts synonym variants as grounding (女友/对象)", () => {
    expect(ungroundedRelationTerm("我给女朋友买过什么礼物", "给女友买了条围巾")).toBeNull();
    expect(ungroundedRelationTerm("我给女朋友买过什么礼物", "和对象一起挑了礼物")).toBeNull();
  });

  it("does not fire when the question has no relation qualifier", () => {
    expect(ungroundedRelationTerm("我买过什么书", bookSource)).toBeNull();
  });

  it("does not fire for grounded 爸妈 (nz9-style note)", () => {
    expect(ungroundedRelationTerm("我打算给爸妈买什么生日礼物", "考虑给爸妈买台按摩椅当生日礼物")).toBeNull();
    expect(ungroundedRelationTerm("给父母买过什么", "考虑给爸妈买台按摩椅")).toBeNull();
  });

  it("flags other family members without grounding", () => {
    expect(ungroundedRelationTerm("我给老婆买过什么生日礼物", bookSource)).toBe("老婆");
    expect(ungroundedRelationTerm("同事送过我什么", bookSource)).toBe("同事");
  });
});

describe("buildNoAnswerResponse missingTerm (P1-1)", () => {
  it("names the missing relation term with suggestions", () => {
    const { answer, references } = buildNoAnswerResponse(
      [{ id: "a", title: "买书", content: "买了本书" }],
      "not_in_notes",
      "女朋友"
    );
    expect(answer).toContain("没有提到与「女朋友」相关的信息");
    expect(references).toHaveLength(1);
  });

  it("names the missing relation term with zero suggestions", () => {
    const { answer, references } = buildNoAnswerResponse([], "not_in_notes", "女朋友");
    expect(answer).toContain("「女朋友」");
    expect(references).toHaveLength(0);
  });
});

describe("financeAggIntent 并列聚合 (P2-1)", () => {
  it("routes 支出和收入分别多少 to exact aggregation", () => {
    expect(financeAggIntent("本月支出和收入分别多少")).toBe("exact");
    expect(financeAggIntent("本月支出和收入分别是多少")).toBe("exact");
    expect(financeAggIntent("这个月收入和支出各是多少")).toBe("exact");
  });

  it("keeps fact-query 分别 wording out of aggregation", () => {
    expect(financeAggIntent("键盘和鼠标分别是什么牌子")).toBeNull();
  });
});

describe("financeDualWindowIntent (P2-2)", () => {
  const now = new Date("2026-08-22T12:00:00Z");

  it("parses 上半年 vs 下半年到现在", () => {
    const r = financeDualWindowIntent("今年上半年和下半年到现在，哪段花得多", now);
    expect(r).not.toBeNull();
    expect(r!.a.phrase).not.toBe(r!.b.phrase);
  });

  it("parses month-vs-month comparisons", () => {
    const r = financeDualWindowIntent("3月和5月哪个月花得多", now);
    expect(r).not.toBeNull();
  });

  it("stays null without two distinct windows or without finance words", () => {
    expect(financeDualWindowIntent("上半年花了多少", now)).toBeNull();
    expect(financeDualWindowIntent("上半年和上半年哪段花得多", now)).toBeNull();
    expect(financeDualWindowIntent("3月和5月哪个月心情好", now)).toBeNull();
  });
});

describe("financeListTopicTerms (P2-3)", () => {
  it("keeps the topic qualifier on 列一下买书的支出", () => {
    const r = financeListTopicTerms("列一下买书的支出");
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("expense");
    expect(r!.terms.join("")).toContain("书");
  });

  it("stays null for plain unqualified list questions", () => {
    expect(financeListTopicTerms("把咱的支出都列一下")).toBeNull();
    expect(financeListTopicTerms("列出所有收入")).toBeNull();
  });
});

describe("单字主题 (P3-1)", () => {
  it("extracts single-char 书 when it stands alone in the question", () => {
    expect(financeTopicTerms("买书一共花了多少")).toEqual(["买书"]);
    expect(financeTopicTerms("书相关的支出一共多少")).toEqual(["书"]);
  });

  it("keeps beneficiary/generic wording fail-closed (R242 口径不变)", () => {
    expect(financeTopicTerms("给猫花的钱合计有多少")).toBeNull();
  });

  it("filters rows where the single char only appears inside compounds", () => {
    const rows = [
      row({ id: "b1", title: "买书：《置身事内》", content: "买了本《置身事内》52 元", tags: '["买书"]' }),
      row({ id: "led7", title: "办公采购台账", content: "打印纸,45\n订书机\t37", tags: '["记账"]' }),
    ];
    const kept = filterSingleCharTopicRows(rows, ["书"]);
    expect(kept.map((n) => n.id)).toEqual(["b1"]);
  });

  it("returns empty when every hit is compound-only (fail-closed, 宁缺毋滥)", () => {
    const rows = [row({ id: "led7", title: "办公采购台账", content: "订书机\t37" })];
    expect(filterSingleCharTopicRows(rows, ["书"])).toHaveLength(0);
  });
});

describe("expenseFacet (P3-2)", () => {
  it("routes 主要花在哪些方面 wording", () => {
    expect(expenseFacetIntent("我的钱主要花在哪些方面")).toBe(true);
    expect(expenseFacetIntent("我的支出构成是什么样的")).toBe(true);
    expect(expenseFacetIntent("花钱的大头是什么")).toBe(true);
  });

  it("stays false for plain aggregate/list questions", () => {
    expect(expenseFacetIntent("本月花了多少")).toBe(false);
    expect(expenseFacetIntent("把支出列一下")).toBe(false);
  });

  it("builds a deterministic tag summary", () => {
    const rows = [
      row({ id: "a", amount: 300, tags: '["餐饮"]' }),
      row({ id: "b", amount: 200, tags: '["餐饮"]' }),
      row({ id: "c", amount: 549, tags: '["购物","健身"]' }),
      row({ id: "d", amount: 50 }),
    ];
    const a = buildExpenseFacetAnswer(rows, null);
    expect(a).toContain("标签归纳");
    expect(a).toContain("餐饮");
    expect(a).toContain("购物");
  });

  it("says so honestly with zero expense rows", () => {
    const a = buildExpenseFacetAnswer([], "本月");
    expect(a).toContain("没有");
  });
});
