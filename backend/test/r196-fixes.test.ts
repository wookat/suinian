// R196（audit-r195）：
// P1-1 含「退款」行、无支出动词的净正额台账被 R118 词面方向兜底改判
//      income（8/8 生产复现，污染全账合计）——多行台账的方向语义在整表
//      层面，fixFinanceDirection 对 parseLedgerCore 命中的台账跳过整条
//      词面兜底，方向交回模型主判；与 R194 台账形态用例集合并
//      （分隔符×正负号×方向×合计行）锁住。
// P2-1 台账行级明细问答返回整表合计（答非所问）——关键词命中台账明细行
//      （标题不含该词）时按命中行的行级金额计入并明示口径。
import { describe, it, expect } from "vitest";
import { fixFinanceDirection, fixLedgerAmount, ledgerRowsMatching } from "../src/triage";
import type { TriageResult } from "../src/types";
import { buildFinanceSubsetAnswer } from "../src/ask";

const t = (category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult => ({
  category,
  title: null,
  tags: [],
  todo_due: null,
  is_sensitive: false,
  amount: null,
  currency: null,
  ...extra,
});

// R195 P1-1 生产原文：含退款行、无支出动词的净正额台账
const OFFICE_LEDGER = "上周办公台账：\n打印纸 120\n工位绿植 368.5\n快递退款 -34.5\n合计 454";
const PURCHASE_LEDGER = "二组采购台账\n胶带,20\n标签纸,45.5\n运费退款,-12";

describe("台账不适用整条词面方向兜底 (R196 P1-1)", () => {
  it("含退款行的净正额台账（空格分隔+合计行）模型判 expense 不被翻成 income", () => {
    expect(fixFinanceDirection(OFFICE_LEDGER, t("expense")).category).toBe("expense");
  });
  it("逗号分隔、无合计行同口径", () => {
    expect(fixFinanceDirection(PURCHASE_LEDGER, t("expense")).category).toBe("expense");
  });
  it("分隔符变体（tab/全角逗号/分号/混合）口径一致", () => {
    for (const sep of ["\t", "，", ";", "；"]) {
      const ledger = `胶带${sep}20\n标签纸${sep}45.5\n运费退款${sep}-12`;
      expect(fixFinanceDirection(ledger, t("expense")).category).toBe("expense");
    }
    expect(fixFinanceDirection("胶带,20\n标签纸\t45.5\n运费退款；-12", t("expense")).category).toBe("expense");
  });
  it("台账模型判 income 也不被词面兜底翻方向（方向交模型主判）", () => {
    const incomeLedger = "五月回款台账\n项目A尾款,5000\n项目B预付款,3000";
    expect(fixFinanceDirection(incomeLedger, t("income")).category).toBe("income");
  });
  it("与 fixLedgerAmount 组合：方向保持 expense、金额取合计行 454", () => {
    const out = fixLedgerAmount(OFFICE_LEDGER, fixFinanceDirection(OFFICE_LEDGER, t("expense")));
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(454);
  });
  it("与 fixLedgerAmount 组合：无合计行带符号求和 53.5", () => {
    const out = fixLedgerAmount(PURCHASE_LEDGER, fixFinanceDirection(PURCHASE_LEDGER, t("expense")));
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(53.5);
  });
  it("单笔叙述（非台账）词面兜底行为不变（R118 回归）", () => {
    expect(fixFinanceDirection("吉他课今天交了下半月学费 400 元", t("income")).category).toBe("expense");
    expect(fixFinanceDirection("退货的鞋退款 269 已收到", t("expense")).category).toBe("income");
    expect(fixFinanceDirection("学生给我交了补课费 300", t("income")).category).toBe("income");
  });
});

const FOOD_LEDGER = "本周餐饮台账\n早餐豆浆油条,12.5\n请客团建烧烤,286.5\n外卖退款,-33.5\n工作餐,155";

describe("ledgerRowsMatching (R196 P2-1)", () => {
  it("命中名目字段的明细行返回行级金额", () => {
    expect(ledgerRowsMatching(FOOD_LEDGER, ["团建烧烤"])).toEqual([{ label: "请客团建烧烤", amount: 286.5 }]);
  });
  it("负数行也能行级命中", () => {
    expect(ledgerRowsMatching(FOOD_LEDGER, ["外卖退款"])).toEqual([{ label: "外卖退款", amount: -33.5 }]);
  });
  it("合计行不参与匹配", () => {
    expect(ledgerRowsMatching(OFFICE_LEDGER, ["合计"])).toEqual([]);
  });
  it("零命中/非台账返回空", () => {
    expect(ledgerRowsMatching(FOOD_LEDGER, ["咖啡"])).toEqual([]);
    expect(ledgerRowsMatching("买了咖啡 30 元", ["咖啡"])).toEqual([]);
  });
});

describe("buildFinanceSubsetAnswer 台账行级明细 (R196 P2-1)", () => {
  const ledgerNote = {
    id: "n1",
    title: "本周餐饮台账",
    content: FOOD_LEDGER,
    tags: "[]",
    created_at: "2026-08-17 04:00:00",
    category: "expense",
    is_sensitive: 0,
    amount: 420.5,
    currency: "CNY",
  } as const;
  it("问句命中台账明细行时按行级金额作答，不吐整表合计", () => {
    const md = buildFinanceSubsetAnswer(["团建烧烤"], [ledgerNote], null);
    expect(md).toContain("¥286.50");
    expect(md).toContain("台账行级明细");
    expect(md).not.toContain("¥420.50");
  });
  it("关键词命中台账标题（问的是台账本身）仍用整表合计", () => {
    const md = buildFinanceSubsetAnswer(["餐饮台账"], [ledgerNote], null);
    expect(md).toContain("¥420.50");
    expect(md).toContain("台账多笔合计");
  });
  it("行级命中与普通单笔混合时各按各的口径计入", () => {
    const single = { ...ledgerNote, id: "n2", title: null, content: "团建烧烤补充饮料 40 元", amount: 40 };
    const md = buildFinanceSubsetAnswer(["团建烧烤"], [ledgerNote, single], null);
    expect(md).toContain("¥326.50");
  });
});
