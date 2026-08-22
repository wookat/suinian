import { describe, it, expect } from "vitest";
import { applyTriageFixes, fixNegativeAmount } from "../src/triage";
import type { TriageResult } from "../src/types";
import { financeListIntent, financeTopicTerms, isFinanceAggQuestion, financeAggIntent } from "../src/ask";

const NOW = new Date("2026-08-22T12:00:00Z");
const TZ = "Asia/Shanghai";

function t(category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult {
  return {
    category,
    tags: [],
    title: "",
    is_sensitive: false,
    todo_due: null,
    amount: null,
    currency: null,
    merchant: null,
    is_question: false,
    ...extra,
  } as TriageResult;
}

// ---- P2-1: 退票/退款净额负金额收入收口（audit-r253：income -930 污染合计）----
describe("negative income amount (P2-1)", () => {
  const refundNote = "机票退票，退回 1130 手续费扣了 200";
  it("normalizes 退票净额 to positive income regardless of model direction", () => {
    for (const cat of ["income", "expense"] as const) {
      const r = applyTriageFixes(refundNote, t(cat), NOW, TZ);
      expect(r.category).toBe("income");
      expect(r.amount).toBe(930);
    }
  });
  it("「手续费」 is not expense-direction evidence (续费 word-inside guard)", () => {
    const r = applyTriageFixes("退货退款 200，手续费扣了 5", t("income"), NOW, TZ);
    expect(r.category).toBe("income");
    expect(r.amount).toBe(195);
  });
  it("fixNegativeAmount flips negative expense/income to positive income without expense evidence", () => {
    const r = fixNegativeAmount("退款到账", t("income", { amount: -930 }));
    expect(r).toMatchObject({ category: "income", amount: 930, currency: "CNY" });
  });
  it("fixNegativeAmount keeps category but abs() when expense evidence exists", () => {
    const r = fixNegativeAmount("买菜花了不少，退了点", t("expense", { amount: -25 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(25);
  });
  it("fixNegativeAmount abs() for transfer and leaves positives untouched", () => {
    expect(fixNegativeAmount("提现", t("transfer", { amount: -2000 })).amount).toBe(2000);
    const same = t("income", { amount: 100 });
    expect(fixNegativeAmount("x", same)).toBe(same);
  });
  it("keeps 赔付/退货/返现 direction+amount families positive", () => {
    const cases: [string, "income" | "expense", TriageResult["category"], number][] = [
      ["快递丢件，平台赔付 25 到账", "income", "income", 25],
      ["退货退款 99 到账", "income", "income", 99],
      ["网购返现 15", "income", "income", 15],
    ];
    for (const [content, model, cat, amount] of cases) {
      const r = applyTriageFixes(content, t(model, { amount }), NOW, TZ);
      expect(r.category, content).toBe(cat);
      expect(r.amount, content).toBe(amount);
    }
  });
});

// ---- P2-2: 收入向动词的列举变体（audit-r253：「今天收到了哪些钱」判成支出）----
describe("financeListIntent income verbs (P2-2)", () => {
  it("routes 收到/到账/进账/入账 listing variants to income", () => {
    expect(financeListIntent("今天收到了哪些钱")).toBe("income");
    expect(financeListIntent("今天收到的钱有哪些")).toBe("income");
    expect(financeListIntent("到账了哪些钱")).toBe("income");
    expect(financeListIntent("这周入账了哪些款")).toBe("income");
    expect(financeListIntent("进账了些什么钱")).toBe("income");
  });
  it("keeps bare 哪些钱 on the expense side", () => {
    expect(financeListIntent("最近一周我花了哪些钱")).toBe("expense");
    expect(financeListIntent("哪些钱")).toBe("expense");
  });
});

// ---- P2-3: 方向 × 语序 × 框架词矩阵（audit-r253：倒装/口语语序不命中）----
describe("financeListIntent direction × word-order × framework matrix (P2-3)", () => {
  const matrix: [string, "income" | "expense" | "both"][] = [
    // 收入 × 正装/倒装
    ["列出所有收入", "income"],
    ["我所有收入列一下", "income"],
    ["把我的收入都列出来", "income"],
    ["收入列出来", "income"],
    // 支出 × 正装/倒装 × 框架词（把/都/请/帮我/咱/你）
    ["把咱的支出都列一下", "expense"],
    ["你把全部支出列出来", "expense"],
    ["支出列出来", "expense"],
    ["请帮我列一下全部开销", "expense"],
    ["列出我所有支出", "expense"],
    // 双向
    ["把收入和支出都列一下", "both"],
  ];
  it.each(matrix)("%s → %s", (q, dir) => {
    expect(financeListIntent(q)).toBe(dir);
  });
  it("still rejects topic-qualified listings", () => {
    expect(financeListIntent("买了哪些书")).toBeNull();
    expect(financeListIntent("列一下买咖啡的支出")).toBeNull();
    expect(financeListIntent("列一下打车相关的支出")).toBeNull();
  });
});

// ---- P3-3: 口语化结余「净剩」并入聚合口径 ----
describe("净剩 as balance wording (P3-3)", () => {
  it("routes 净剩 questions to the exact aggregate", () => {
    expect(isFinanceAggQuestion("这个月净剩多少")).toBe(true);
    expect(financeAggIntent("工资到账后这个月净剩多少")).toBe("exact");
  });
});

// ---- P3-4: 「X相关的支出」语序的「相关」框架残片剥净 ----
describe("相关的 residue trim (P3-4)", () => {
  it("no longer injects 「书相关的」 as a LIKE keyword", () => {
    expect(financeTopicTerms("书相关的支出一共多少")).toBeNull();
  });
  it("keeps multi-char topics after trimming 相关", () => {
    expect(financeTopicTerms("咖啡相关的支出一共多少")).toEqual(["咖啡"]);
    expect(financeTopicTerms("咖啡相关一共花了多少")).toEqual(["咖啡"]);
  });
});
