// R112: P2-1 finance-intent synonym coverage, P1-1 multi-hop question gating,
// and the dangling citation lead-in cleanup ("参见 ，" after marker removal).
import { describe, it, expect } from "vitest";
import { financeAggIntent, reconcileAskCitations, MULTI_HOP_RE } from "../src/ask";

describe("financeAggIntent R112 synonyms (P2-1)", () => {
  it("routes 开支/用掉/用了 aggregate wording to the exact aggregate", () => {
    expect(financeAggIntent("本月开支加起来是多少")).toBe("exact");
    expect(financeAggIntent("这个月我总共用掉多少钱")).toBe("exact");
  });
  it("keeps qualified aggregates fail-closed (no LLM mental math)", () => {
    expect(financeAggIntent("给猫的开支一共是多少")).toBe("fail_closed");
    expect(financeAggIntent("最近买东西一共用了多少钱")).toBe("fail_closed");
  });
  it("still ignores non-finance 用了 (no amount wording)", () => {
    expect(financeAggIntent("项目用了什么技术方案")).toBe(null);
  });
  it("keeps the original routing intact", () => {
    expect(financeAggIntent("这个月总共花了多少钱")).toBe("exact");
    expect(financeAggIntent("上个月我花销总额是多少")).toBe("exact");
    expect(financeAggIntent("买咖啡花了多少钱")).toBe(null);
  });
});

describe("reconcileAskCitations dangling lead-in cleanup (R111 q54)", () => {
  it("removes 参见/详见 left dangling by out-of-range marker removal", () => {
    const { answer } = reconcileAskCitations("项目进展参见 [7]，方案B已经落地 [1]。", ["a", "b"], new Set());
    expect(answer).not.toContain("参见");
    expect(answer).toContain("[1]");
    expect(answer).not.toContain("，，");
  });
  it("removes empty parentheses left after marker removal", () => {
    const { answer } = reconcileAskCitations("方案B已经落地（[9]）[1]。", ["a", "b"], new Set());
    expect(answer).not.toContain("（）");
    expect(answer).toContain("[1]");
  });
  it("leaves normal answers untouched", () => {
    const { answer } = reconcileAskCitations("参见笔记里的方案B [1]，进展顺利 [2]。", ["a", "b"], new Set());
    expect(answer).toBe("参见笔记里的方案B [1]，进展顺利 [2]。");
  });
});

describe("MULTI_HOP_RE gating (P1-1)", () => {
  it("matches the four known multi-hop question styles", () => {
    expect(MULTI_HOP_RE.test("我为什么想做周末快闪店？依据是哪几条笔记")).toBe(true);
    expect(MULTI_HOP_RE.test("白板照片里的供应链目标后来有具体着落了吗")).toBe(true);
    expect(MULTI_HOP_RE.test("那个让我暂缓换工作的项目，技术方案上最近有什么进展")).toBe(true);
    expect(MULTI_HOP_RE.test("参加市集活动这个目标和我哪个创业想法是一体的")).toBe(true);
  });
  it("does not trigger on plain single-hop lookups", () => {
    expect(MULTI_HOP_RE.test("土鸡蛋报价是多少")).toBe(false);
    expect(MULTI_HOP_RE.test("上周记了哪些待办")).toBe(false);
  });
});
