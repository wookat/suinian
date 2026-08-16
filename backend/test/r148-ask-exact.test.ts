import { describe, it, expect } from "vitest";
import {
  financeExtremeIntent,
  buildFinanceExtremeAnswer,
  topicCountIntent,
  buildTopicCountAnswer,
  financeTopicTerms,
  buildFinanceSubsetAnswer,
  financeAggIntent,
  countQueryIntent,
} from "../src/ask";
import type { NoteRow } from "../src/types";

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

describe("financeExtremeIntent", () => {
  it("routes 最贵的一笔支出 to max/expense", () => {
    expect(financeExtremeIntent("我最贵的一笔支出是什么")).toEqual({ kind: "max", direction: "expense" });
    expect(financeExtremeIntent("最贵的一笔支出")).toEqual({ kind: "max", direction: "expense" });
    expect(financeExtremeIntent("金额最大的一笔消费")).toEqual({ kind: "max", direction: "expense" });
  });

  it("routes income extremes to income", () => {
    expect(financeExtremeIntent("最大的一笔收入是哪笔")).toEqual({ kind: "max", direction: "income" });
  });

  it("routes min wording", () => {
    expect(financeExtremeIntent("最便宜的一笔支出")).toEqual({ kind: "min", direction: "expense" });
  });

  it("stays null for non-finance superlatives and plain questions", () => {
    expect(financeExtremeIntent("最长的一条笔记是哪条")).toBeNull();
    expect(financeExtremeIntent("咖啡一共花了多少")).toBeNull();
    expect(financeExtremeIntent("最早的笔记是什么时候记的")).toBeNull();
  });
});

describe("buildFinanceExtremeAnswer", () => {
  it("answers single-currency max with amount, time and citation", () => {
    const a = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense" },
      [row({ amount: 8999, content: "下单买了 MacBook Air M4，花了 8999 元" })],
      0,
      null
    );
    expect(a).toContain("¥8999");
    expect(a).toContain("[1]");
    expect(a).toContain("数据库精确查询");
  });

  it("masks sensitive extreme rows", () => {
    const a = buildFinanceExtremeAnswer({ kind: "max", direction: "expense" }, [row({ is_sensitive: 1 })], 0, null);
    expect(a).toContain("敏感笔记");
    expect(a).not.toContain("[1]");
  });

  it("lists per-currency extremes without cross-currency comparison", () => {
    const a = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense" },
      [row({ amount: 8999 }), row({ id: "n2", amount: 200, currency: "USD" })],
      2,
      null
    );
    expect(a).toContain("按币种分别比较");
    expect(a).toContain("另有 2 笔未识别出金额");
  });

  it("handles no comparable rows", () => {
    const a = buildFinanceExtremeAnswer({ kind: "max", direction: "expense" }, [], 3, null);
    expect(a).toContain("无法比较");
  });
});

describe("topicCountIntent", () => {
  it("extracts the topic from 记录过几次X wording", () => {
    expect(topicCountIntent("我记录过几次房租")).toBe("房租");
    expect(topicCountIntent("记了几次房租？")).toBe("房租");
    expect(topicCountIntent("提到过多少次咖啡")).toBe("咖啡");
  });

  it("extracts the topic from X记过几次 wording", () => {
    expect(topicCountIntent("房租一共记录过几次")).toBe("房租");
  });

  it("stays null for generic or short topics and fact questions", () => {
    expect(topicCountIntent("我记过几次东西")).toBeNull();
    expect(topicCountIntent("记了几条笔记")).toBeNull();
    expect(topicCountIntent("哪些笔记提到过几次房租")).toBeNull();
  });

  it("does not hijack plain count questions (existing route)", () => {
    expect(countQueryIntent("我一共记了多少条笔记")?.intent).toBe("exact");
    expect(topicCountIntent("我一共记了多少条笔记")).toBeNull();
  });
});

describe("buildTopicCountAnswer", () => {
  it("states the keyword-match口径 and count", () => {
    const a = buildTopicCountAnswer("房租", 6, 0, null);
    expect(a).toContain("「房租」");
    expect(a).toContain("6 条");
    expect(a).toContain("关键词匹配口径");
  });

  it("handles zero matches honestly", () => {
    expect(buildTopicCountAnswer("房租", 0, 0, null)).toContain("没有匹配到");
  });
});

describe("financeTopicTerms", () => {
  it("extracts a clean topic from qualified sum questions", () => {
    expect(financeTopicTerms("咖啡一共花了多少")).toEqual(["咖啡"]);
    expect(financeTopicTerms("买咖啡总共花了多少钱")).toEqual(["咖啡"]);
    expect(financeTopicTerms("吃喝花了多少")).toEqual(["吃喝"]);
  });

  it("stays null for overall aggregates (exact route keeps them)", () => {
    expect(financeAggIntent("这个月一共花了多少钱")).toBe("exact");
    expect(financeTopicTerms("这个月一共花了多少钱")).toBeNull();
  });

  it("stays null for fact-style questions", () => {
    expect(financeTopicTerms("买的两本书叫什么，一共花了多少钱")).toBeNull();
  });

  it("stays null when no clean topic term extracts", () => {
    expect(financeTopicTerms("乱七八糟的东西加上其它一共花了多少钱算算看")).toBeNull();
  });
});

describe("buildFinanceSubsetAnswer", () => {
  const coffee = [
    row({ id: "c1", amount: 18, content: "买咖啡 18 元" }),
    row({ id: "c2", amount: 30, content: "咖啡续命 30 元" }),
  ];

  it("sums the keyword-matched subset exactly with itemized lines", () => {
    const a = buildFinanceSubsetAnswer(["咖啡"], coffee, null);
    expect(a).toContain("2 笔支出");
    expect(a).toContain("¥48");
    expect(a).toContain("[1]");
    expect(a).toContain("关键词匹配口径");
  });

  it("counts sensitive rows into totals without exposing content", () => {
    const a = buildFinanceSubsetAnswer(["咖啡"], [...coffee, row({ id: "c3", amount: 52, is_sensitive: 1, content: "[加密内容]" })], null);
    expect(a).toContain("¥100");
    expect(a).toContain("1 笔加密的敏感记录");
    expect(a).not.toContain("[加密内容]");
  });

  it("reports unknown-amount rows separately", () => {
    const a = buildFinanceSubsetAnswer(["咖啡"], [...coffee, row({ id: "c4", amount: null })], null);
    expect(a).toContain("1 笔未识别出金额");
    expect(a).toContain("¥48");
  });
});
