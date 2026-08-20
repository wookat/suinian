// R206（audit-r205）：
// P2-1 多行台账分拣漂移双修（生产 6/6 复现）：
//      case B「回款台账」——收入向多行台账被模型判 data 且 amount=null，
//      周报/财务问答漏计 → fixLedgerCategory 在表格结构可解析且全文只有
//      单一方向台账词面证据时，把非财务分类收口成对应方向（模型判了财务
//      方向时不动，R196 口径不变）。
//      case A「办公用品台账…供应商退款 454」——正数书写的退款行被并入
//      支出合计（1134，实应净额 226）→ signedRowAmount 对退款语义名目的
//      正数金额取负冲减；显式负号退款行不重复取反。
import { describe, it, expect } from "vitest";
import {
  fixLedgerCategory,
  fixLedgerAmount,
  fixFinanceDirection,
  parseLedgerCore,
  ledgerRowsMatching,
} from "../src/triage";
import type { TriageResult } from "../src/types";

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

// audit-r205 P2-1 生产原文
const INCOME_LEDGER = "回款台账\n3月项目尾款 4500\n4月咨询费 3200\n5月维护费 1800";
const REFUND_LEDGER = "办公用品台账\n打印纸 120\n墨盒 260\n耗材 300\n供应商退款 454";

describe("收入向台账分类收口 (R206 P2-1 case B)", () => {
  it("生产原文：模型判 data 收口成 income，金额由 fixLedgerAmount 锁定合计", () => {
    const fixed = fixLedgerAmount(INCOME_LEDGER, fixLedgerCategory(INCOME_LEDGER, t("data")));
    expect(fixed.category).toBe("income");
    expect(fixed.amount).toBe(9500);
    expect(fixed.currency).toBe("CNY");
  });
  it("收款/入账/货款词面同口径收口", () => {
    for (const head of ["收款台账", "本月入账明细", "货款流水"]) {
      const ledger = `${head}\n渠道A,2000\n渠道B,1500`;
      expect(fixLedgerCategory(ledger, t("data")).category).toBe("income");
    }
  });
  it("支出向词面台账判 data 时收口成 expense", () => {
    const ledger = "二组采购台账\n胶带,20\n标签纸,45.5";
    expect(fixLedgerCategory(ledger, t("data")).category).toBe("expense");
  });
  it("模型已判财务方向时不动（R196：台账方向模型主判）", () => {
    expect(fixLedgerCategory(INCOME_LEDGER, t("income")).category).toBe("income");
    expect(fixLedgerCategory(REFUND_LEDGER, t("expense", { amount: 226 }))).toEqual(
      t("expense", { amount: 226 })
    );
  });
  it("双向词面证据并存不收口（歧义不猜）", () => {
    const ledger = "收入支出台账\n项目款 3000\n采购 1200";
    expect(fixLedgerCategory(ledger, t("data")).category).toBe("data");
  });
  it("无方向词面证据的台账不收口", () => {
    const ledger = "家居台账\n窗帘,180\n地垫,30";
    expect(fixLedgerCategory(ledger, t("data")).category).toBe("data");
  });
  it("非台账内容不收口（含「回款」的普通资料照旧）", () => {
    expect(fixLedgerCategory("回款流程说明：先开票再走 OA 审批", t("data")).category).toBe("data");
  });
  it("「退款」不算收入向证据（退款行属冲减）", () => {
    expect(fixLedgerCategory(REFUND_LEDGER + "\n快递退款 10", t("data")).category).toBe("data");
  });
});

describe("正数退款行冲减 (R206 P2-1 case A)", () => {
  it("生产原文：合计按退款行冲减为净额 226", () => {
    expect(parseLedgerCore(REFUND_LEDGER)).toEqual({ amount: 226, rows: 4 });
  });
  it("模型金额 1134 被 fixLedgerAmount 锁回净额 226", () => {
    expect(fixLedgerAmount(REFUND_LEDGER, t("expense", { amount: 1134, currency: "CNY" })).amount).toBe(226);
  });
  it("显式负号退款行不重复取反（R194/R198 口径不回归）", () => {
    expect(
      parseLedgerCore("早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5")
    ).toEqual({ amount: 420.5, rows: 4 });
    expect(
      parseLedgerCore("周末出行开销：车费 46，门票 120，午餐 88，纪念品退款 -30，合计 224")
    ).toEqual({ amount: 224, rows: 4 });
  });
  it("合计行存在时仍以合计值为准（不叠加冲减）", () => {
    expect(parseLedgerCore("家居台账\n窗帘\t180\n地垫退货退款\t-30\n合计\t150")).toEqual({
      amount: 150,
      rows: 2,
    });
  });
  it("ledgerRowsMatching 返回冲减后的带符号明细", () => {
    expect(ledgerRowsMatching(REFUND_LEDGER, ["退款"])).toEqual([{ label: "供应商退款", amount: -454 }]);
    expect(ledgerRowsMatching(REFUND_LEDGER, ["墨盒"])).toEqual([{ label: "墨盒", amount: 260 }]);
  });
  it("正数退款行使单行散文台账可识别（与负号写法同口径）", () => {
    expect(parseLedgerCore("退换记录：外套退款 199，鞋 89，路费 20")).toEqual({ amount: -90, rows: 3 });
  });
  it("台账方向守卫不回归：净正额含退款行台账模型判 expense 不被翻 income", () => {
    expect(fixFinanceDirection(REFUND_LEDGER, t("expense")).category).toBe("expense");
  });
});
