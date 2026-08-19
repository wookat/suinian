// R192（audit-r191）：
// P1-1 空格分隔台账逃逸——splitCsvFields 无显式分隔符时退回按空白切分，
//      全部分隔符变体（逗号/制表符/分号/空格/混合）走同一台账识别口径，
//      台账合计绝不冒充单笔参与极值/序数排名；
// P2-1 「按价格从高到低排，第三名」类无财务词序数问法收口进确定性路线；
// P2-2 财务子集关键词整串 LIKE 零命中时降级重试（剥残片/拆词），不再一次
//      miss 即 fail-closed。
import { describe, it, expect } from "vitest";
import { parseLedgerTable, splitCsvFields } from "../src/triage";
import {
  isLedgerAggregateNote,
  financeExtremeIntent,
  financeExtremeTopicTerms,
  degradeFinanceSubsetTerms,
} from "../src/ask";

// ---- P1-1: 空格分隔台账 ----

describe("splitCsvFields 空白退化切分 (R192 P1)", () => {
  it("无显式分隔符的行按连续空白切分", () => {
    expect(splitCsvFields("早餐豆浆油条 12.5")).toEqual(["早餐豆浆油条", "12.5"]);
    expect(splitCsvFields("午饭  盖浇饭   21")).toEqual(["午饭", "盖浇饭", "21"]);
    expect(splitCsvFields("打车\u3000368.5")).toEqual(["打车", "368.5"]);
  });

  it("有显式分隔符的行不受影响", () => {
    expect(splitCsvFields("a,b\tc；d，e")).toEqual(["a", "b", "c", "d", "e"]);
    expect(splitCsvFields("手抓饼 葱多加, 6.5")).toEqual(["手抓饼 葱多加", "6.5"]);
  });

  it("引号包裹的字段不被空白切开", () => {
    expect(splitCsvFields('"午饭 牛肉面"')).toEqual(["午饭 牛肉面"]);
    expect(splitCsvFields('"午饭,牛肉面",38')).toEqual(["午饭,牛肉面", "38"]);
  });
});

describe("parseLedgerTable 分隔符全变体 (R192 P1)", () => {
  const EXPECT = { amount: 454, rows: 3 };
  it("空格分隔多行台账解析出合计", () => {
    expect(parseLedgerTable("早餐豆浆油条 12.5\n请客吃饭 155\n团建烧烤 286.5")).toEqual(EXPECT);
  });
  it("逗号/制表符/分号变体口径一致", () => {
    expect(parseLedgerTable("早餐豆浆油条,12.5\n请客吃饭,155\n团建烧烤,286.5")).toEqual(EXPECT);
    expect(parseLedgerTable("早餐豆浆油条\t12.5\n请客吃饭\t155\n团建烧烤\t286.5")).toEqual(EXPECT);
    expect(parseLedgerTable("早餐豆浆油条;12.5\n请客吃饭;155\n团建烧烤;286.5")).toEqual(EXPECT);
    expect(parseLedgerTable("早餐豆浆油条；12.5\n请客吃饭；155\n团建烧烤；286.5")).toEqual(EXPECT);
  });
  it("混合分隔符（逐行不同）口径一致", () => {
    expect(parseLedgerTable("早餐豆浆油条,12.5\n请客吃饭 155\n团建烧烤\t286.5")).toEqual(EXPECT);
  });
  it("空格台账带标题行/表头照常解析", () => {
    expect(parseLedgerTable("本周餐饮台账\n早餐豆浆油条 12.5\n请客吃饭 155\n团建烧烤 286.5")).toEqual(EXPECT);
    expect(parseLedgerTable("项目 金额\n早餐豆浆油条 12.5\n请客吃饭 155\n团建烧烤 286.5")).toEqual(EXPECT);
  });
  it("空格台账带合计行取合计值", () => {
    expect(parseLedgerTable("早餐 12.5\n午饭 21\n合计 33.5")).toEqual({ amount: 33.5, rows: 2 });
  });
  it("散文不误判（既有口径不回归）", () => {
    expect(parseLedgerTable("今天买了咖啡 38 元\n很好喝")).toBeNull();
    expect(parseLedgerTable("买键盘 459")).toBeNull();
  });
});

describe("isLedgerAggregateNote 空格台账收口 (R192 P1)", () => {
  const spaceLedger = { content: "早餐豆浆油条 12.5\n请客吃饭 155\n团建烧烤 286.5", amount: 454 };
  it("空格分隔台账合计不再冒充单笔", () => {
    expect(isLedgerAggregateNote(spaceLedger)).toBe(true);
  });
  it("用户手改过金额（非合计）则照常参与", () => {
    expect(isLedgerAggregateNote({ ...spaceLedger, amount: 460 })).toBe(false);
  });
  it("逗号台账既有行为不回归", () => {
    expect(
      isLedgerAggregateNote({ content: "日期,项目,金额\n8-14,手抓饼,6.5\n8-14,午饭,21\n8-15,打车,368.5", amount: 396 })
    ).toBe(true);
  });
});

// ---- P2-1: 排序指令短语序数收口 ----

describe("排序指令短语序数问法 (R192 P2-1)", () => {
  it("「按价格从高到低排，第三名」收口进确定性路线", () => {
    expect(financeExtremeIntent("按价格从高到低排，第三名是什么？")).toEqual({ kind: "max", direction: "expense", rank: 3 });
    expect(financeExtremeIntent("按金额从低到高排，第二名是哪笔")).toEqual({ kind: "min", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("按金额排第二的支出")).toEqual({ kind: "max", direction: "expense", rank: 2 });
  });

  it("排序短语的残渣不注入 WHERE（主题限定为空）", () => {
    expect(financeExtremeTopicTerms("按价格从高到低排，第三名是什么？")).toBeNull();
  });

  it("非价格排序/时间序数不误收口", () => {
    expect(financeExtremeIntent("按时间排，第三条笔记是什么")).toBeNull();
    expect(financeExtremeIntent("第二次买咖啡是什么时候")).toBeNull();
  });
});

// ---- P2-2: 财务子集关键词降级重试 ----

describe("degradeFinanceSubsetTerms (R192 P2-2)", () => {
  it("剥掉台账/账本容器残片", () => {
    expect(degradeFinanceSubsetTerms(["台账里团建烧烤"])).toEqual(["团建烧烤"]);
    expect(degradeFinanceSubsetTerms(["账本上打车"])).toEqual(["打车"]);
  });

  it("剥掉「什么牌子」类疑问残片", () => {
    expect(degradeFinanceSubsetTerms(["空气炸锅什么牌子"])).toEqual(["空气炸锅"]);
    expect(degradeFinanceSubsetTerms(["显示器是什么型号"])).toEqual(["显示器"]);
  });

  it("剥不动的长词按「的」拆开", () => {
    expect(degradeFinanceSubsetTerms(["上次团建的烧烤"])).toEqual(["上次团建", "烧烤"]);
  });

  it("无可降级时返回 null（不做无谓重试）", () => {
    expect(degradeFinanceSubsetTerms(["咖啡"])).toBeNull();
    expect(degradeFinanceSubsetTerms(["机械键盘"])).toBeNull();
  });
});
