import { describe, it, expect } from "vitest";
import { guardedTopicHits, scopeGuardedByTopic } from "../src/prompt-armor";
import {
  attributableTopicTerms,
  sensitiveTopicTerms,
  sensitiveTermScore,
  sensitiveTopicHits,
  ownTopicCards,
  topicHitCards,
  plainTopicHitCards,
} from "../src/sensitive-recall";

// R347：归因 / 敏感召回比对面按同一字表折叠繁体——繁体问句归因到简体笔记（反向亦然），
// 与简体问句逐对同结果；比对面折叠不进任何输出（卡对象原样返回）。

const locker = { id: "n1", title: "储物柜", content: "健身房储物柜密码 4471，周三换的", tags: null as string | null };
const cat = { id: "n2", title: "猫粮", content: "猫粮一袋 89 元，京东买的", tags: null as string | null };
const lockerTrad = { id: "n3", title: "儲物櫃", content: "健身房儲物櫃密碼 4471，週三換的", tags: null as string | null };
const cards = [locker, cat, lockerTrad];
const textOf = (n: typeof locker) => `${n.title ?? ""}\n${n.content}\n${n.tags ?? ""}`;
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe("R347 attribution folds Han variants on the comparison side only", () => {
  it("attributableTopicTerms strips traditional credential labels", () => {
    expect(attributableTopicTerms(["儲物櫃密碼"])).toEqual(["储物柜"]);
    expect(attributableTopicTerms(["储物柜密码"])).toEqual(["储物柜"]);
    expect(attributableTopicTerms(["密碼"])).toEqual([]);
    expect(sensitiveTopicTerms(["保險箱的密碼"])).toEqual(sensitiveTopicTerms(["保险箱的密码"]));
  });

  it("guardedTopicHits: traditional topic hits the simplified card and vice versa", () => {
    for (const topics of [["储物柜"], ["儲物櫃"], ["儲物櫃密碼"]]) {
      expect(ids(guardedTopicHits(cards, topics, textOf))).toEqual(["n1", "n3"]);
      expect(ids(scopeGuardedByTopic(cards, topics, textOf))).toEqual(["n1", "n3"]);
    }
    // 不相干话题仍不命中（不是把所有卡都放宽）
    expect(ids(guardedTopicHits(cards, ["保險箱"], textOf))).toEqual([]);
    expect(ids(scopeGuardedByTopic(cards, ["保險箱"], textOf))).toEqual(["n1", "n2", "n3"]);
  });

  it("sensitive recall scoring is script-agnostic", () => {
    for (const [terms, topics] of [
      [["儲物櫃密碼"], ["储物柜"]],
      [["储物柜密码"], ["儲物櫃"]],
      [["儲物櫃"], ["儲物櫃"]],
    ] as Array<[string[], string[]]>) {
      expect(sensitiveTermScore(locker.content, null, terms, topics)).toBe(1);
      expect(sensitiveTermScore(lockerTrad.content, null, terms, topics)).toBe(1);
      expect(sensitiveTopicHits(locker.content, null, terms, topics)).toBe(1);
      expect(sensitiveTermScore(cat.content, null, terms, topics)).toBe(0);
    }
  });

  it("topic card narrowing treats 儲物櫃 / 储物柜 as the same topic", () => {
    expect(ids(ownTopicCards(cards, ["儲物櫃"]))).toEqual(["n1", "n3"]);
    expect(ids(topicHitCards(cards, ["儲物櫃"]))).toEqual(["n1", "n3"]);
    expect(ids(topicHitCards(cards, ["储物柜"]))).toEqual(["n1", "n3"]);
    expect(ids(plainTopicHitCards(cards, ["貓糧"]))).toEqual(["n2"]);
    expect(ids(plainTopicHitCards(cards, ["猫粮"]))).toEqual(["n2"]);
    // 折叠只在比对面：返回的卡对象是原对象、正文未改
    expect(topicHitCards(cards, ["儲物櫃"])[1]).toBe(lockerTrad);
    expect(lockerTrad.content).toContain("儲物櫃");
  });

  it("Japanese / Latin topics are unaffected", () => {
    const jp = { id: "j", title: null, content: "書斎の金庫の暗証は 1234", tags: null };
    expect(ids(topicHitCards([jp, cat], ["金庫"]))).toEqual(["j"]);
    expect(ids(topicHitCards([jp, cat], ["wifi"]))).toEqual([]);
  });
});
