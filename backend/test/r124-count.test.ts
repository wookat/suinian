// R124 P1-2：计数/枚举类提问必须走精确 SQL 聚合，绝不让 LLM 从 top-k 检索
// 窗口猜总数（R123 实测：实为 210 条被答成 16）。
import { describe, it, expect } from "vitest";
import { countAggIntent, enumListIntent, buildCountAnswer, buildCountFailClosedAnswer, financeAggIntent } from "../src/ask";

describe("countAggIntent", () => {
  it("纯计数问题（可带时间）判 exact", () => {
    expect(countAggIntent("我一共记了多少条笔记")).toBe("exact");
    expect(countAggIntent("我记了多少条")).toBe("exact");
    expect(countAggIntent("这个月记了几条笔记")).toBe("exact");
    expect(countAggIntent("去年一共写了多少篇")).toBe("exact");
    expect(countAggIntent("到目前为止我存了多少条记录？")).toBe("exact");
  });

  it("带主题限定的计数判 fail_closed（拒绝猜数）", () => {
    expect(countAggIntent("关于咖啡的笔记有多少条")).toBe("fail_closed");
    expect(countAggIntent("我记了多少条健身相关的笔记")).toBe("fail_closed");
  });

  it("金额类计数交财务路径，不判计数意图", () => {
    expect(countAggIntent("这个月花了多少钱")).toBeNull();
    expect(financeAggIntent("这个月花了多少钱")).toBe("exact");
    expect(countAggIntent("上个月记了几笔支出")).toBeNull();
  });

  it("非计数问题不误伤", () => {
    expect(countAggIntent("昨天的会议记录说了什么")).toBeNull();
    expect(countAggIntent("健身计划是什么")).toBeNull();
    expect(countAggIntent("买的两本书叫什么")).toBeNull();
  });
});

describe("enumListIntent", () => {
  it("时间窗枚举措辞命中", () => {
    expect(enumListIntent("上周都记了什么")).toBe(true);
    expect(enumListIntent("这个月我都记了些什么")).toBe(true);
    expect(enumListIntent("昨天记了哪些")).toBe(true);
  });

  it("普通问答不命中", () => {
    expect(enumListIntent("健身计划是什么")).toBe(false);
    expect(enumListIntent("上周花了多少钱")).toBe(false);
  });
});

describe("buildCountAnswer", () => {
  it("给出精确总数与分类分布", () => {
    const a = buildCountAnswer(
      210,
      [
        { category: "idea", cnt: 100 },
        { category: "expense", cnt: 60 },
        { category: null, cnt: 50 },
      ],
      3,
      "今年"
    );
    expect(a).toContain("210 条");
    expect(a).toContain("想法 100 条");
    expect(a).toContain("待分类 50 条");
    expect(a).toContain("3 条加密");
    expect(a).toContain("精确统计");
  });

  it("零条笔记如实说明", () => {
    expect(buildCountAnswer(0, [], 0, "上周")).toContain("没有记录");
  });

  it("fail-closed 说明不估算并附精确总数", () => {
    const a = buildCountFailClosedAnswer(210, [], 0, null);
    expect(a).toContain("不做估算");
    expect(a).toContain("210 条");
  });
});
