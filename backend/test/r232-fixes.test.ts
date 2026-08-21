import { describe, it, expect } from "vitest";
import {
  buildTriagePrompt,
  fixLedgerNetDirection,
  fixLedgerAmount,
  parseLedgerTable,
  fixAaReimburse,
  fixTransferMisfile,
  fixAdvanceRepayAmount,
} from "../src/triage";
import { scrubUnsourcedAmounts } from "../src/ask";
import type { Category, TriageResult } from "../src/types";

const finance = (category: Category, amount: number | null): TriageResult => ({
  category,
  tags: [],
  title: null,
  is_sensitive: false,
  todo_due: null,
  amount,
  currency: "CNY",
  merchant: null,
});

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

// ---- P2-1（audit-r231 §2）：「金额×负数简写×括号备注」组合 10/10 降级 idea
// 丢金额——few-shot 回流（不加正则），prompt 判例覆盖全组合 ----
describe("R232 P2-1 inline shorthand ledger few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the production-failing full-combination sentence as income 22", () => {
    expect(prompt).toContain("零食 8 退货 -30(质量差)");
    expect(prompt).toContain("8−30=−22 净流入");
  });
  it("includes the no-space full-combination variant", () => {
    expect(prompt).toContain("零食8退货-30(质量差)");
  });
  it("includes the no-parenthesis variant (金额+负数简写)", () => {
    expect(prompt).toContain("零食 8 退货 -30」→ income，amount=22（没有括号备注也一样）");
  });
  it("includes the refund-only variant (负数简写+括号备注)", () => {
    expect(prompt).toContain("退货 -30(质量差)」→ income，amount=30");
  });
  it("includes the parenthesis-only positive variant (金额+括号备注)", () => {
    expect(prompt).toContain("零食 8(小卖部)」→ expense，amount=8");
  });
  it("keeps the R210 mixed-sign short sentence judgement (不回归)", () => {
    expect(prompt).toContain("午饭 20 咖啡 -5(退款)");
  });
});

// ---- P2-1 既有确定性管线不回归：模型判成财务类后，台账解析与净额方向
// 仲裁仍把全组合句锁到 income 22 ----
describe("R232 P2-1 deterministic ledger pipeline still rescues finance-classified shorthand", () => {
  const SENT = "零食 8 退货 -30(质量差)";
  it("parseLedgerTable nets the mixed-sign shorthand to -22", () => {
    expect(parseLedgerTable(SENT)).toEqual({ amount: -22, rows: 2 });
  });
  it("fixLedgerAmount + fixLedgerNetDirection lock expense to income 22", () => {
    const out = fixLedgerNetDirection(SENT, fixLedgerAmount(SENT, finance("expense", null)));
    expect(out.category).toBe("income");
    expect(out.amount).toBe(22);
  });
  it("refund-only shorthand stays out of the two-row ledger gate (single entry, model主判)", () => {
    expect(parseLedgerTable("退货 -30(质量差)")).toBeNull();
  });
});

// ---- P3-1（audit-r231 §4 Q23）：库内无余额事实，模型用 500+100−45 推算出
// 「还剩 555」当事实——无币种单位的结余句式逃过无来源金额剥除 ----
describe("R232 P3-1 unsourced balance-claim scrub", () => {
  const SOURCE = "剪头发的卡充了 500\n又充了 100\n剪头发用了 45";
  it("scrubs a computed bare-number balance not present in any source", () => {
    expect(scrubUnsourcedAmounts("卡里还剩 555。", SOURCE)).toBe("");
    expect(scrubUnsourcedAmounts("余额为555。", SOURCE)).toBe("");
  });
  it("scrubs equation-form computed balances (R232 生产复测形态)", () => {
    expect(scrubUnsourcedAmounts("剪头发的卡充了 500，剪头发用了 45，所以还剩 500 - 45 = 455。", SOURCE)).toBe("");
    expect(scrubUnsourcedAmounts("还剩 500 + 100 - 45 = 555。", SOURCE)).toBe("");
  });
  it("keeps balance statements whose number is sourced", () => {
    const src = `${SOURCE}\n会员卡还剩 320`;
    expect(scrubUnsourcedAmounts("卡里还剩 320。", src)).toBe("卡里还剩 320。");
  });
  it("keeps unrelated sentences and existing currency-token scrub behavior", () => {
    expect(scrubUnsourcedAmounts("充值记录有 500 元和 100 元。", SOURCE)).toBe("充值记录有 500 元和 100 元。");
    expect(scrubUnsourcedAmounts("周六花了 20 元买菜。", SOURCE)).toBe("");
  });
});

// ---- P3-3（audit-r231 §1）：「帮同事垫的 90 块他今天微信还我了」判 transfer
// ——「帮…垫的」定语式无时间词前缀且非「垫付」全词，两个既往垫付收口都不
// 触发，而 fixTransferMisfile 的 还我×垫的 词面把 income 翻成 transfer ----
describe("R232 P3-3 attributive past-advance repayment consistency", () => {
  const SENT = "帮同事垫的 90 块他今天微信还我了";
  it("fixTransferMisfile still flips the raw income to transfer (词面兜底不变)", () => {
    expect(fixTransferMisfile(SENT, finance("income", 90)).category).toBe("transfer");
  });
  it("fixAaReimburse now rescues the attributive 「帮…垫的」 repayment back to income", () => {
    expect(fixAaReimburse(SENT, finance("transfer", 90))).toMatchObject({ category: "income", amount: 90 });
  });
  it("keeps R230 past-advance rescue for time-worded variants", () => {
    expect(fixAaReimburse("上周帮朋友垫的电影票 45 他刚还我", finance("transfer", 45)).category).toBe("income");
    expect(fixAaReimburse("上次帮小刘垫的 90 他微信转我了", finance("expense", 90)).category).toBe("income");
  });
  it("does not rescue un-repaid pending debts (仍是 transfer 挂账)", () => {
    expect(fixAaReimburse("帮同事垫的 300 块房费他一直没给我", finance("transfer", 300)).category).toBe("transfer");
  });
  it("does not touch present-tense 垫付+回款 netting (仍记 expense 总额)", () => {
    const sent = "帮同事垫付门票 300 元，他微信转我 300 元";
    const out = fixAdvanceRepayAmount(sent, fixAaReimburse(sent, finance("transfer", 300)));
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(300);
  });
});
