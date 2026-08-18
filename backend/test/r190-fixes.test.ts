// R190（audit-r189）：
// P1-1 极值/序数路由缝隙——「单笔最贵」「按金额排」的功能词残渣不再注入
//      WHERE（剥词 fail-safe：非名词性残渣视为无主题限定），台账明细行
//      绝不冒充单笔（isLedgerAggregateNote 口径不回归）；
// P1-2 敏感零召回指引——不再依赖凭据关键词词典，凭据/非凭据同一分支架构
//      （sensitiveFallbackHintLine），count-only 绝不露标题/正文/凭据。
import { describe, it, expect } from "vitest";
import {
  financeExtremeIntent,
  financeExtremeTopicTerms,
  buildFinanceExtremeAnswer,
  isLedgerAggregateNote,
  sensitiveFallbackHintLine,
  credentialHintLine,
  sensitiveHintLine,
} from "../src/ask";

// ---- P1-1: 极值/序数意图全组合（R189 实测缝隙锁死） ----

describe("financeExtremeIntent R189 实测缝隙 (R190 P1-1)", () => {
  it("「单笔最贵/最便宜」变体收口进确定性极值路由", () => {
    expect(financeExtremeIntent("单笔最贵的一笔支出是多少钱")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("单笔最贵的一笔支出是多少钱？买的什么？")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("单笔最便宜的一笔支出是哪一笔")).toEqual({ kind: "min", direction: "expense", rank: 1 });
  });

  it("「按金额排」序数变体收口（R189：残渣「按排」致零命中）", () => {
    expect(financeExtremeIntent("按金额排，第二贵的东西是什么")).toEqual({ kind: "max", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("支出第二高的是哪一笔")).toEqual({ kind: "max", direction: "expense", rank: 2 });
  });

  it("既有问法不回归", () => {
    expect(financeExtremeIntent("最贵的一笔花销是什么")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("花得最多的一笔是哪个")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("倒数第二贵的支出")).toEqual({ kind: "min", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("最大的一笔收入是哪笔")).toEqual({ kind: "max", direction: "income", rank: 1 });
    expect(financeExtremeIntent("最长的一条笔记是哪条")).toBeNull();
    expect(financeExtremeIntent("咖啡一共花了多少")).toBeNull();
  });
});

describe("financeExtremeTopicTerms 剥词残渣 fail-safe (R190 P1-1)", () => {
  it("「单笔」「按排」等功能词残渣视为无主题限定（不注入 WHERE）", () => {
    expect(financeExtremeTopicTerms("单笔最贵的一笔支出是多少钱")).toBeNull();
    expect(financeExtremeTopicTerms("单笔最贵的一笔支出是多少钱？买的什么？")).toBeNull();
    expect(financeExtremeTopicTerms("单笔最便宜的一笔支出是哪一笔")).toBeNull();
    expect(financeExtremeTopicTerms("按金额排，第二贵的东西是什么")).toBeNull();
    expect(financeExtremeTopicTerms("按金额从高到低排，第三贵的是什么")).toBeNull();
  });

  it("真实主题限定词照常提取（不因 fail-safe 误伤）", () => {
    expect(financeExtremeTopicTerms("我买过的键盘里最贵的是哪一把")).toEqual(["键盘"]);
    expect(financeExtremeTopicTerms("买的耳机里最便宜的是哪个")).toEqual(["耳机"]);
    // 含功能字的正常名词不被 fail-safe 误杀（排骨含「排」、大衣含「大」）
    expect(financeExtremeTopicTerms("买过的排骨里最贵的一次是多少钱")).toEqual(["排骨"]);
    expect(financeExtremeTopicTerms("单笔最贵的键盘是哪一把")).toEqual(["键盘"]);
  });
});

// ---- P1-1: 极值×序数×台账全组合答案口径 ----

const row = (id: string, amount: number, content: string, sensitive = false) => ({
  id,
  title: null,
  content,
  created_at: "2026-08-01 08:00:00",
  is_sensitive: sensitive ? 1 : 0,
  amount,
  currency: "CNY",
});

describe("极值/序数/台账组合答案 (R190 P1-1)", () => {
  it("台账聚合笔记不参与单笔比较（isLedgerAggregateNote 不回归）", () => {
    const ledger = {
      content: "日期,项目,金额\n8-14,手抓饼,6.5\n8-14,午饭,21\n8-15,打车,368.5",
      amount: 396,
    };
    expect(isLedgerAggregateNote(ledger)).toBe(true);
    // 用户手改过金额（非合计）则照常参与
    expect(isLedgerAggregateNote({ ...ledger, amount: 400 })).toBe(false);
    expect(isLedgerAggregateNote({ content: "买键盘 459", amount: 459 })).toBe(false);
  });

  it("rank=1 单币种：报台账排除口径", () => {
    const md = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 1 },
      [row("a", 459, "买了个机械键盘 459")],
      0,
      null,
      null,
      1
    );
    expect(md).toContain("459");
    expect(md).toContain("多行台账笔记的金额为多笔合计");
  });

  it("rank=2 不足两笔：如实说明不存在第 2 名", () => {
    const md = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 2 },
      [],
      0,
      null,
      null,
      0,
      [{ currency: "CNY", count: 1 }]
    );
    expect(md).toContain("不存在");
  });

  it("敏感笔记只报金额不露内容", () => {
    const md = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 1 },
      [row("s", 999, "机密内容", true)],
      0,
      null
    );
    expect(md).toContain("999");
    expect(md).not.toContain("机密内容");
    expect(md).toContain("敏感笔记");
  });
});

// ---- P1-2: 敏感零召回指引同一分支架构 ----

describe("sensitiveFallbackHintLine (R190 P1-2)", () => {
  it("凭据措辞 = credentialHintLine（同一架构不复制粘贴）", () => {
    expect(credentialHintLine()).toBe(sensitiveFallbackHintLine(true));
    expect(credentialHintLine()).toContain("原图");
  });

  it("非凭据措辞：有解锁/搜索入口，无原图口径", () => {
    const hint = sensitiveFallbackHintLine(false);
    expect(hint).toContain("解锁");
    expect(hint).toContain("时间流");
    expect(hint).not.toContain("原图");
    expect(hint).not.toContain("账号密码");
  });

  it("count-only：既有 sensitiveHintLine 口径不回归", () => {
    const hint = sensitiveHintLine(2, ["储物柜"]);
    expect(hint).toContain("2 条");
    expect(hint).toContain("储物柜");
    expect(hint).toContain("解锁");
  });
});
