// R242 修改轮（audit-r241）：P2 「的」字变体聚合问法收口 + P3-1 主题词残片修剪
import { describe, expect, it } from "vitest";
import { financeAggIntent, financeTopicTerms, financeShortTopicTerms, degradeAskTerms } from "../src/ask";

describe("R242 P2: 「的」字变体聚合问法走精确聚合（audit-r241 §3.1）", () => {
  it("「这个月的总支出/总收入」带「的」仍判 exact", () => {
    expect(financeAggIntent("这个月的总支出是多少")).toBe("exact");
    expect(financeAggIntent("这个月的总收入是多少")).toBe("exact");
    expect(financeAggIntent("上个月的结余是多少")).toBe("exact");
    expect(financeAggIntent("这个月的支出一共是多少")).toBe("exact");
    expect(financeAggIntent("我的总支出一共是多少")).toBe("exact");
    expect(financeAggIntent("这个月的开销怎么样")).toBe("exact");
  });

  it("不带「的」的既有问法口径不变", () => {
    expect(financeAggIntent("这个月总支出是多少")).toBe("exact");
    expect(financeAggIntent("这个月都花了多少钱")).toBe("exact");
  });

  it("带「的」的主题限定合计绝不落全账精确聚合", () => {
    expect(financeAggIntent("这个月的咖啡一共花了多少钱")).not.toBe("exact");
    expect(financeTopicTerms("这个月的咖啡一共花了多少钱")).toEqual(["咖啡"]);
  });
});

describe("R242 P3-1: 主题词残片修剪（audit-r241 §4）", () => {
  it("「的」贴在主题两侧时剪掉残片", () => {
    expect(financeTopicTerms("咖啡的钱一共花了多少")).toEqual(["咖啡"]);
    expect(financeShortTopicTerms("这个月的咖啡多少钱")).toEqual(["咖啡"]);
  });

  it("剩余不足 2 字时不修剪（「的士」不能剪成「士」）", () => {
    expect(financeTopicTerms("的士一共花了多少钱")).toEqual(["的士"]);
  });

  it("受益格「给X」介词剥掉、泛指「买东西」不构成主题：整题回落 fail-closed 全账口径", () => {
    expect(financeTopicTerms("给猫花的钱合计有多少")).toBeNull();
    expect(financeAggIntent("给猫花的钱合计有多少")).toBe("fail_closed");
    expect(financeTopicTerms("那买东西一共用了多少钱")).toBeNull();
    expect(financeAggIntent("那买东西一共用了多少钱")).toBe("fail_closed");
    expect(financeTopicTerms("给妹妹买生日礼物一共花了多少钱")).toEqual(["妹妹买生日礼物"]);
  });

  it("普通召回降级剥掉句首指代「那/这」", () => {
    expect(degradeAskTerms(["那买东西"])).toEqual(["买东西"]);
  });

  it("既有主题提取行为不回退（R240 口径）", () => {
    expect(financeTopicTerms("成都出差一共花了多少钱")).toEqual(["成都出差"]);
    expect(financeTopicTerms("买咖啡豆一共花了多少钱")).toEqual(["咖啡豆"]);
  });
});
