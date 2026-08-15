import { describe, it, expect } from "vitest";
import { topicEnumIntent, financeClarifyTerms, buildFinanceClarifyAnswer, buildFinanceAggAnswer } from "../src/ask";
import { financeStats } from "../src/reports";
import type { NoteRow } from "../src/types";

describe("topicEnumIntent", () => {
  it("识别「经历动词+哪些/什么+主题词」的枚举问题", () => {
    expect(topicEnumIntent("我看过什么书")).toBe("书");
    expect(topicEnumIntent("我都存过哪些菜谱？")).toBe("菜谱");
    expect(topicEnumIntent("我读过哪些书来着")).toBe("书");
    expect(topicEnumIntent("买过什么咖啡")).toBe("咖啡");
  });

  it("识别「关于 X 的笔记有哪些」句式", () => {
    expect(topicEnumIntent("关于健身的笔记有哪些")).toBe("健身");
    expect(topicEnumIntent("有哪些关于纳瓦尔的记录")).toBe("纳瓦尔");
  });

  it("泛指宾语（东西/什么/笔记）不算主题枚举", () => {
    expect(topicEnumIntent("我都存过哪些东西")).toBeNull();
    expect(topicEnumIntent("我记过什么内容")).toBeNull();
    expect(topicEnumIntent("上周都记了什么")).toBeNull();
  });

  it("财务/计数/极值问题不被抢路由", () => {
    expect(topicEnumIntent("这个月花了多少钱")).toBeNull();
    expect(topicEnumIntent("我一共记了多少条笔记")).toBeNull();
    expect(topicEnumIntent("最早的一条笔记是什么")).toBeNull();
  });

  it("普通语义问题不受影响", () => {
    expect(topicEnumIntent("健身计划是什么")).toBeNull();
    expect(topicEnumIntent("纳瓦尔怎么看待财富")).toBeNull();
  });
});

const FN = (over: Partial<NoteRow>): NoteRow =>
  ({
    id: "n1",
    user_id: "u1",
    content: "打车 38 元",
    title: null,
    category: "expense",
    tags: null,
    amount: 38,
    currency: "CNY",
    is_sensitive: 0,
    created_at: "2026-08-01 00:00:00",
    ...over,
  }) as NoteRow;

describe("financeClarifyTerms", () => {
  const agg = buildFinanceAggAnswer(financeStats([FN({})]), "这个月");

  it("上一轮是精确合计时识别口径澄清限定词", () => {
    expect(financeClarifyTerms("包括报销的差旅费吗", agg)).toEqual(["报销", "差旅费"]);
    expect(financeClarifyTerms("算上房租了吗？", agg)).toEqual(["房租"]);
  });

  it("上一轮不是精确合计答案时不触发", () => {
    expect(financeClarifyTerms("包括报销的差旅费吗", null)).toBeNull();
    expect(financeClarifyTerms("包括报销的差旅费吗", "上个月你去了杭州")).toBeNull();
  });

  it("非澄清句式不触发", () => {
    expect(financeClarifyTerms("那上个月呢", agg)).toBeNull();
    expect(financeClarifyTerms("这个月花了多少钱", agg)).toBeNull();
  });
});

describe("buildFinanceClarifyAnswer", () => {
  const stats = financeStats([FN({}), FN({ id: "n2", category: "transfer", amount: 1560, content: "报销差旅费 1560 元" })]);

  it("transfer 类直答不包括并解释口径", () => {
    const a = buildFinanceClarifyAnswer(
      ["报销", "差旅费"],
      [FN({ id: "n2", category: "transfer", amount: 1560, content: "报销差旅费 1560 元" })],
      stats,
      "这个月"
    );
    expect(a.startsWith("不包括。")).toBe(true);
    expect(a).toContain("资金往来");
  });

  it("expense 类直答包括", () => {
    const a = buildFinanceClarifyAnswer(["打车"], [FN({})], stats, "这个月");
    expect(a.startsWith("包括。")).toBe(true);
    expect(a).toContain("已计入支出合计");
  });
});
