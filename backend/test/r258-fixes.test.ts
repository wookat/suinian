import { describe, expect, it } from "vitest";
import {
  financeDualWindowIntent,
  financeDualWindowTopicTerms,
  financeListIntent,
  financeAggAnswerTerms,
  categoryEnumIntent,
  bareTimeWindowListIntent,
  buildFinanceMomAnswer,
  financeListFollowUpIntent,
} from "../src/ask";

// R258：audit-r257 P2×3 同根收口（组合限定词在统一管道中的交接缺口）+ P3 落实

describe("financeDualWindowTopicTerms (R258 P2-1)", () => {
  it("双窗对比携带主题限定词", () => {
    expect(financeDualWindowTopicTerms("3月和4月哪个月买书花得多")).toEqual(["买书"]);
    expect(financeDualWindowTopicTerms("这个月和上个月哪个月买书花得多")).toEqual(["买书"]);
    expect(financeDualWindowTopicTerms("上周和这周哪周喝咖啡花得多")).toEqual(["咖啡"]);
  });
  it("纯时间窗对比无主题：返回 null（行为与既有全账对比一致）", () => {
    expect(financeDualWindowTopicTerms("今年上半年和下半年到现在，哪段花得多")).toBeNull();
    expect(financeDualWindowTopicTerms("这个月和上个月哪个月开销大")).toBeNull();
    expect(financeDualWindowTopicTerms("3月和4月哪个月花得多")).toBeNull();
  });
  it("双窗意图本身不受主题词影响", () => {
    expect(financeDualWindowIntent("3月和4月哪个月买书花得多")).not.toBeNull();
    expect(financeDualWindowIntent("这个月和上个月哪个月花得多")).not.toBeNull();
  });
});

describe("buildFinanceMomAnswer topic 口径回显 (R258 P2-1)", () => {
  const stats = { totals: { CNY: { expense: 52, income: 0 } }, expenseCount: 1, incomeCount: 0, unknownAmount: 0, transferCount: 0 };
  const zero = { totals: {}, expenseCount: 0, incomeCount: 0, unknownAmount: 0, transferCount: 0 };
  it("带主题时答案回显关键词口径", () => {
    const md = buildFinanceMomAnswer(stats, zero, "3月", "4月", ["买书"]);
    expect(md).toContain("按关键词「买书」精确匹配");
    expect(md).toContain("关键词匹配口径");
  });
  it("双窗都零命中时如实说明且带关键词口径", () => {
    const md = buildFinanceMomAnswer(zero, zero, "3月", "4月", ["买书"]);
    expect(md).toContain("都没有匹配的记账记录");
    expect(md).toContain("按关键词「买书」");
  });
  it("无主题时答案与既有口径一致（不出现关键词字样）", () => {
    const md = buildFinanceMomAnswer(stats, zero, "3月", "4月");
    expect(md).not.toContain("按关键词");
  });
});

describe("financeListIntent 显式方向词覆盖 cue 默认方向 (R258 P2-2)", () => {
  it("「收入有哪几笔」不再被无方向 cue 抢成收支双向", () => {
    expect(financeListIntent("本月收入有哪几笔")).toBe("income");
    expect(financeListIntent("上个月收入有哪几笔")).toBe("income");
    expect(financeListIntent("本月支出有哪几笔")).toBe("expense");
  });
  it("单限定行为不误伤", () => {
    expect(financeListIntent("去年下半年分别是哪几笔")).toBe("both");
    expect(financeListIntent("这个月的收支明细")).toBe("both");
    expect(financeListIntent("最近记了哪些账")).toBe("both");
    expect(financeListIntent("最近一周我花了哪些钱")).toBe("expense");
    expect(financeListIntent("最近一个月我有哪些收入")).toBe("income");
    expect(financeListIntent("买了哪些书")).toBeNull();
  });
});

describe("financeAggAnswerTerms 关键词限定继承 (R258 P2-3)", () => {
  const SUBSET_AGG =
    "按关键词「买书」精确匹配（标题/正文/标签），今年共 1 笔支出：\n- CNY：支出 ¥52\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。";
  const PLAIN_AGG = "这个月你一共花了 ¥711（共 2 笔支出）。\n\n以上为精确统计，口径与周报/月报一致。";
  it("从子集合计答案解析出关键词限定集", () => {
    expect(financeAggAnswerTerms(SUBSET_AGG)).toEqual(["买书"]);
    expect(financeAggAnswerTerms("按关键词「咖啡、奶茶」精确匹配（标题/正文/标签），…口径与周报/月报一致")).toEqual(["咖啡", "奶茶"]);
  });
  it("非子集答案返回 null（全账追问行为零改动）", () => {
    expect(financeAggAnswerTerms(PLAIN_AGG)).toBeNull();
    expect(financeAggAnswerTerms(null)).toBeNull();
  });
  it("裸列举追问识别不受影响（组合入口）", () => {
    expect(financeListFollowUpIntent("分别是哪几笔？", SUBSET_AGG)).toBe("both");
  });
});

describe("categoryEnumIntent 分类名直问 (R258 P3-3)", () => {
  it("待办/分类名直问走确定性枚举", () => {
    expect(categoryEnumIntent("我有什么待办事项？")).toBe("待办事项");
    expect(categoryEnumIntent("我有哪些待办")).toBe("待办");
    expect(categoryEnumIntent("我的收藏有哪些")).toBe("收藏");
  });
  it("带主题限定/无枚举措辞不劫走", () => {
    expect(categoryEnumIntent("我有哪些关于健身的想法")).toBeNull();
    expect(categoryEnumIntent("我收藏过哪些技术类的文章")).toBeNull();
    expect(categoryEnumIntent("这几天有什么要办的事")).toBeNull();
    expect(categoryEnumIntent("待办事项是什么意思")).toBeNull();
  });
});

describe("bareTimeWindowListIntent 裸时间短语 (R258 P3-1)", () => {
  it("裸时间短语路由时间窗枚举", () => {
    expect(bareTimeWindowListIntent("3月份")).toBe(true);
    expect(bareTimeWindowListIntent("上个月")).toBe(true);
    expect(bareTimeWindowListIntent("3月份呢？")).toBe(true);
  });
  it("带实义残留/非时间问题不劫走", () => {
    expect(bareTimeWindowListIntent("3月份买了什么")).toBe(false);
    expect(bareTimeWindowListIntent("特斯拉股票")).toBe(false);
    expect(bareTimeWindowListIntent("3月份的支出")).toBe(false);
  });
});
