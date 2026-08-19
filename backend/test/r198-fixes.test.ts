// R198（audit-r197）：
// P1   单行散文式台账（「周末出行开销：车费 46，门票 120，午餐 88，纪念品
//      退款 -30，合计 224」）不被 parseLedgerCore 识别，R196 台账守卫不
//      生效，「退款」词面把整条翻成 income——单行散文按逗号/分号分段后
//      复用同一表格结构识别（inlineLedgerRows→ledgerRowsFromLines），
//      仅当有合计行或负数（退款）行才认作台账，与既有台账形态用例集
//      合并（单行/多行×分隔符×正负×方向×序数/极值）。
// §3   短问法「X多少钱」数据门控路由：不放宽 FINANCE_WORD_RE，主题词
//      查库命中财务笔记标题/正文才走确定性子集答案（门控在路由层，
//      financeShortTopicTerms 只负责问法识别与主题词提取）。
// P3-3 确定性财务答案带时间范围时明示「按笔记记录时间划定」口径。
// P3-4 「倒数第N便宜/贵」双关：答案附排序口径说明。
import { describe, it, expect } from "vitest";
import { fixFinanceDirection, fixLedgerAmount, parseLedgerCore, ledgerRowsMatching } from "../src/triage";
import type { TriageResult, NoteRow } from "../src/types";
import {
  financeShortTopicTerms,
  financeExtremeIntent,
  buildFinanceExtremeAnswer,
  buildFinanceAggAnswer,
  buildFinanceSubsetAnswer,
  isLedgerAggregateNote,
  buildLedgerRowExtremeAnswer,
} from "../src/ask";
import { financeStats } from "../src/reports";

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

// audit-r197 P1 生产原文
const TRIP_LEDGER = "周末出行开销：车费 46，门票 120，午餐 88，纪念品退款 -30，合计 224";

describe("单行散文式台账结构识别 (R198 P1)", () => {
  it("生产原文：识别为台账，合计 224、4 行明细", () => {
    expect(parseLedgerCore(TRIP_LEDGER)).toEqual({ amount: 224, rows: 4 });
  });
  it("无合计行但含负数退款行也认作台账（净额求和）", () => {
    expect(parseLedgerCore("退换记录：外套退款 -199，鞋 89，路费 20")).toEqual({ amount: -90, rows: 3 });
  });
  it("无合计且无负数的单行含数句子不认作台账（避免误伤）", () => {
    expect(parseLedgerCore("买了三样：苹果 10，香蕉 5，橙子 8")).toBeNull();
  });
  it("非金额语义的单行句子不认作台账", () => {
    expect(parseLedgerCore("今天跑步 5 公里，用时 30 分钟，配速 6")).toBeNull();
    expect(parseLedgerCore("午饭和同事AA，一共 3 个人，我付了 90")).toBeNull();
  });
  it("分隔符变体（全角/半角逗号、分号、顿号）口径一致", () => {
    for (const sep of ["，", ",", "；", ";", "、"]) {
      const line = `聚餐开销：烧烤 180${sep}饮料 45${sep}合计 225`;
      expect(parseLedgerCore(line)).toEqual({ amount: 225, rows: 2 });
    }
  });
  it("不足三段不认作台账（「合计 224」独立短句不误伤）", () => {
    expect(parseLedgerCore("纪念品退款 -30，合计 224")).toBeNull();
  });
});

describe("单行散文台账方向守卫 (R198 P1：R196 守卫扩展到单行)", () => {
  it("生产原文：含「退款」的净正额单行台账模型判 expense 不被翻成 income", () => {
    expect(fixFinanceDirection(TRIP_LEDGER, t("expense")).category).toBe("expense");
  });
  it("收入向单行台账（含「退了」字样）模型判 income 不被翻成 expense", () => {
    const ledger = "副业进账：稿费 800，平台服务费退了 -50，合计 750";
    expect(fixFinanceDirection(ledger, t("income")).category).toBe("income");
  });
  it("普通单行句子（非台账）词面方向兜底行为不变", () => {
    expect(fixFinanceDirection("收到退款 30 元", t("expense")).category).toBe("income");
    expect(fixFinanceDirection("交了话费 200", t("income")).category).toBe("expense");
  });
  it("多行台账守卫不回归（R196 P1-1）", () => {
    const multi = "上周办公台账：\n打印纸 120\n工位绿植 368.5\n快递退款 -34.5\n合计 454";
    expect(fixFinanceDirection(multi, t("expense")).category).toBe("expense");
  });
});

describe("单行散文台账金额锁定与行级明细 (R198 P1)", () => {
  it("fixLedgerAmount 以合计行覆盖模型金额", () => {
    expect(fixLedgerAmount(TRIP_LEDGER, t("expense", { amount: 30 })).amount).toBe(224);
  });
  it("ledgerRowsMatching 命中单行台账的明细行", () => {
    expect(ledgerRowsMatching(TRIP_LEDGER, ["门票"])).toEqual([{ label: "门票", amount: 120 }]);
    expect(ledgerRowsMatching(TRIP_LEDGER, ["纪念品"])).toEqual([{ label: "纪念品退款", amount: -30 }]);
  });
  it("isLedgerAggregateNote 识别单行台账聚合（极值排名剔除口径一致）", () => {
    const n = { content: TRIP_LEDGER, amount: 224 };
    expect(isLedgerAggregateNote(n as Pick<NoteRow, "content" | "amount">)).toBe(true);
  });
});

describe("短问法主题词提取 (R198 §3 数据门控路由)", () => {
  it("「X多少钱」提取主题词（audit-r197 实测漏召问法）", () => {
    expect(financeShortTopicTerms("团建烧烤多少钱？")).toEqual(["团建烧烤"]);
    expect(financeShortTopicTerms("工位绿植多少钱？")).toEqual(["工位绿植"]);
    expect(financeShortTopicTerms("打印纸多少钱？")).toEqual(["打印纸"]);
    expect(financeShortTopicTerms("外卖退款多少？")).toEqual(["外卖退款"]);
  });
  it("带财务词的问法交既有 financeTopicTerms 路由（互斥，不放宽 FINANCE_WORD_RE）", () => {
    expect(financeShortTopicTerms("团建烧烤花了多少钱？")).toBeNull();
    expect(financeShortTopicTerms("咖啡一共花了多少")).toBeNull();
  });
  it("代词指代与非多少问法不收口", () => {
    expect(financeShortTopicTerms("它多少钱")).toBeNull();
    expect(financeShortTopicTerms("那个多少钱")).toBeNull();
    expect(financeShortTopicTerms("团建烧烤好吃吗")).toBeNull();
  });
  it("非财务「多少」问法照常提取主题词（收口与否由路由层数据门控决定）", () => {
    expect(financeShortTopicTerms("我的身高多少")).toEqual(["身高"]);
  });
});

describe("台账行级极值 (R198 §3 第 5 点)", () => {
  const ledger = (id: string, title: string, content: string) =>
    ({ id, title, content, currency: "CNY", is_sensitive: 0 }) as unknown as Parameters<
      typeof buildLedgerRowExtremeAnswer
    >[1][number];
  const dining = ledger("n1", "本周餐饮台账", "早餐豆浆油条 12.5\n请客吃饭 155\n团建烧烤 286.5");
  const refunds = ledger("n2", "含退款台账", "早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5");

  it("标题命中：台账全表明细行按金额排序作答", () => {
    const r = buildLedgerRowExtremeAnswer({ kind: "max", direction: "expense", rank: 1 }, [dining], ["餐饮台账"], null);
    expect(r).not.toBeNull();
    expect(r!.answer).toContain("团建烧烤");
    expect(r!.answer).toContain("286.5");
    expect(r!.noteIds).toEqual(["n1"]);
  });
  it("序数：第 2 大取次高明细行", () => {
    const r = buildLedgerRowExtremeAnswer({ kind: "max", direction: "expense", rank: 2 }, [dining], ["餐饮台账"], null);
    expect(r!.answer).toContain("请客吃饭");
    expect(r!.answer).toContain("155");
  });
  it("负数（退款）行不参与大小排序并如实披露", () => {
    const r = buildLedgerRowExtremeAnswer({ kind: "min", direction: "expense", rank: 1 }, [refunds], ["含退款台账"], null);
    expect(r!.answer).toContain("早餐豆浆油条");
    expect(r!.answer).toContain("12.5");
    expect(r!.answer).toContain("负数（退款）明细未参与");
    expect(r!.answer).not.toContain("-33.5");
  });
  it("单行散文台账同口径", () => {
    const trip = ledger("n3", "周末出行开销", TRIP_LEDGER);
    const r = buildLedgerRowExtremeAnswer({ kind: "max", direction: "expense", rank: 1 }, [trip], ["出行开销"], null);
    expect(r!.answer).toContain("门票");
    expect(r!.answer).toContain("120");
  });
  it("明细行不足 rank 时如实说明不存在", () => {
    const r = buildLedgerRowExtremeAnswer({ kind: "max", direction: "expense", rank: 9 }, [dining], ["餐饮台账"], null);
    expect(r).toBeNull();
  });
  it("零命中返回 null（保持既有「无法比较」路径）", () => {
    const r = buildLedgerRowExtremeAnswer({ kind: "max", direction: "expense", rank: 1 }, [dining], ["日用品"], null);
    expect(r).toBeNull();
  });
});

describe("确定性答案时间口径明示 (R198 P3-3)", () => {
  const stats = financeStats([]);
  it("带时间短语的聚合答案明示按记录时间划定", () => {
    const md = buildFinanceAggAnswer({ ...stats, expenseCount: 1, totals: { CNY: { expense: 10, income: 0 } } }, "上周");
    expect(md).toContain("时间范围按笔记记录时间划定");
  });
  it("无时间短语不加口径说明", () => {
    const md = buildFinanceAggAnswer({ ...stats, expenseCount: 1, totals: { CNY: { expense: 10, income: 0 } } }, null);
    expect(md).not.toContain("时间范围按笔记记录时间划定");
  });
  it("子集答案同口径", () => {
    const row = {
      id: "n1",
      title: "买咖啡",
      content: "买咖啡 30 元",
      tags: null,
      created_at: "2026-08-10 08:00:00",
      category: "expense",
      is_sensitive: 0,
      amount: 30,
      currency: "CNY",
    } as unknown as NoteRow;
    expect(buildFinanceSubsetAnswer(["咖啡"], [row], "上周")).toContain("时间范围按笔记记录时间划定");
  });
});

describe("倒数第N便宜/贵 排序口径消歧 (R198 P3-4)", () => {
  it("financeExtremeIntent 记录倒序形容词", () => {
    expect(financeExtremeIntent("倒数第二便宜的支出是哪笔")).toEqual({
      kind: "max",
      direction: "expense",
      rank: 2,
      reversedAdj: "便宜",
    });
  });
  it("非倒序问法不带 reversedAdj", () => {
    expect(financeExtremeIntent("第二便宜的支出是哪笔")).toEqual({ kind: "min", direction: "expense", rank: 2 });
  });
  it("答案附排序口径说明", () => {
    const row = {
      id: "n1",
      title: "买鼠标",
      content: "买鼠标 99 元",
      tags: null,
      created_at: "2026-08-10 08:00:00",
      category: "expense",
      is_sensitive: 0,
      amount: 99,
      currency: "CNY",
    } as unknown as NoteRow;
    const md = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 2, reversedAdj: "便宜" },
      [row],
      0,
      null,
      null,
      0,
      []
    );
    expect(md).toContain("倒数第 2 便宜");
    expect(md).toContain("金额第 2 大");
    expect(md).toContain("第 2 便宜");
  });
});
