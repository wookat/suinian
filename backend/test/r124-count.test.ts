// R124 P1-2：计数/枚举类提问必须走精确 SQL 聚合，绝不让 LLM 从 top-k 检索
// 窗口猜总数（R123 实测：实为 210 条被答成 16）。
import { describe, it, expect } from "vitest";
import { countAggIntent, countQueryIntent, extremeQueryIntent, buildExtremeAnswer, buildScopedCountAnswer, buildAvgPerDayAnswer, enumListIntent, buildCountAnswer, buildCountFailClosedAnswer, financeAggIntent, parseTimeRange } from "../src/ask";

describe("countQueryIntent（R126：可 SQL 化限定不再 fail-closed）", () => {
  it("分类限定计数判 exact 且带 category（R125 Q9/Q10/Q12）", () => {
    expect(countQueryIntent("我的待办有多少条？")).toMatchObject({ intent: "exact", category: "todo" });
    expect(countQueryIntent("想法类的笔记有几条？")).toMatchObject({ intent: "exact", category: "idea" });
    expect(countQueryIntent("我一共收藏了多少条？")).toMatchObject({ intent: "exact", category: "collect" });
  });

  it("敏感/加密限定计数判 exact（R125 Q15）", () => {
    expect(countQueryIntent("加密的敏感笔记有几条？")).toMatchObject({ intent: "exact", sensitiveOnly: true });
    expect(countQueryIntent("敏感笔记有多少条")).toMatchObject({ intent: "exact", sensitiveOnly: true });
  });

  it("日均计数判 exact（R125 Q4）", () => {
    expect(countQueryIntent("我平均每天记几条笔记？")).toMatchObject({ intent: "exact", avgPerDay: true });
  });

  it("绝对月份「7 月」（带空格）可解析并判 exact（R125 Q14）", () => {
    expect(countQueryIntent("7 月我一共记了多少条笔记？")?.intent).toBe("exact");
    const r = parseTimeRange("7 月我一共记了多少条笔记？", new Date("2026-08-14T00:00:00Z"));
    expect(r?.start).toBe("2026-06-30 16:00:00");
    expect(r?.end).toBe("2026-07-31 16:00:00");
  });

  it("主题限定仍 fail-closed（R125 Q11 设计目标）", () => {
    expect(countQueryIntent("关于咖啡的笔记有多少条")?.intent).toBe("fail_closed");
  });
});

describe("extremeQueryIntent / buildExtremeAnswer（R126 P1-3）", () => {
  it("最早/最新/最长命中对应意图", () => {
    expect(extremeQueryIntent("我最早的一条笔记是什么时候记的？")).toBe("earliest");
    expect(extremeQueryIntent("我记的第一条笔记是什么")).toBe("earliest");
    expect(extremeQueryIntent("我最新的一条笔记是什么")).toBe("latest");
    expect(extremeQueryIntent("最长的一条笔记是哪条")).toBe("longest");
  });

  it("笔记内容里的事实极值不误伤", () => {
    expect(extremeQueryIntent("最早的航班是几点")).toBeNull();
    expect(extremeQueryIntent("上个月花得最多的一笔是什么")).toBeNull();
  });

  it("答案含北京时间与精确查询口径声明", () => {
    const a = buildExtremeAnswer("earliest", {
      id: "n1",
      title: null,
      content: "第一条",
      created_at: "2026-07-20 01:00:00",
      is_sensitive: 0,
    });
    expect(a).toContain("最早的一条笔记记于 2026-07-20 09:00");
    expect(a).toContain("数据库精确查询");
  });

  it("敏感笔记只报时间不露内容", () => {
    const a = buildExtremeAnswer("latest", {
      id: "n2",
      title: "秘密",
      content: "wifi 密码 123",
      created_at: "2026-08-01 00:00:00",
      is_sensitive: 1,
    });
    expect(a).not.toContain("123");
    expect(a).not.toContain("秘密");
    expect(a).toContain("加密的敏感笔记");
  });

  it("零条笔记如实说明", () => {
    expect(buildExtremeAnswer("earliest", null)).toContain("还没有记录");
  });
});

describe("buildScopedCountAnswer / buildAvgPerDayAnswer", () => {
  it("限定计数答案带精确口径", () => {
    expect(buildScopedCountAnswer(3, "待办笔记", null)).toContain("3 条待办笔记");
    expect(buildScopedCountAnswer(0, "收藏笔记", "7月")).toContain("没有收藏笔记");
  });

  it("日均答案含天数与均值", () => {
    const a = buildAvgPerDayAnswer(20, "2026-08-01 00:00:00", new Date("2026-08-11T00:00:00Z"));
    expect(a).toContain("10 天");
    expect(a).toContain("2.00 条");
  });
});

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

  it("「有什么记录/有哪些笔记」枚举措辞命中（R246 prod QA：下半年有什么记录漏召回）", () => {
    expect(enumListIntent("下半年有什么记录")).toBe(true);
    expect(enumListIntent("上个季度有哪些笔记")).toBe(true);
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
