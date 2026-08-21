import { describe, it, expect } from "vitest";
import { buildTriagePrompt, ledgerPositiveRows } from "../src/triage";
import { financeExtremeIntent, financeExtremeTopicTerms, isLedgerAggregateNote } from "../src/ask";

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

// ---- P2（audit-r227 §2）：R217 混合付款+平台退款净额 few-shot 回流提示词 ----
describe("R228 P2 mixed payment + refund few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the R217 original sentence as a net-expense judgement", () => {
    expect(prompt).toContain("外卖我付32室友付28平台退34.5");
    expect(prompt).toContain("付款合计−退款");
  });
  it("includes 付款其中退款 / 商家退货 variants", () => {
    expect(prompt).toContain("昨晚打车付款 34.5 其中退款 9");
    expect(prompt).toContain("超市买菜付了 86，有一盒坏了商家退了 12");
  });
  it("keeps the R218 advance-payment rule distinct (amount=本人实付，不净额化)", () => {
    expect(prompt).toContain("我先付了聚餐 480 元，其他人回我 360 元");
  });
});

// ---- P3-3（audit-r227 §2）：「想去预约洗牙」意愿式 → idea few-shot ----
describe("R228 P3-3 想去预约 wish-style idea few-shot", () => {
  it("includes the 洗牙 judgement", () => {
    const prompt = buildTriagePrompt(NOW, [], TZ);
    expect(prompt).toContain("想去预约洗牙");
  });
});

// ---- P3-2（audit-r227 §2）：序数财务问答「最近」措辞剥离 ----
describe("R228 P3-2 bare 最近 stripped from finance extreme topic terms", () => {
  it("最近第二贵的支出 keeps ordinal intent with no topic residue", () => {
    expect(financeExtremeIntent("最近第二贵的支出是哪笔")).toMatchObject({ kind: "max", direction: "expense", rank: 2 });
    expect(financeExtremeTopicTerms("最近第二贵的支出是哪笔")).toBeNull();
  });
  it("近期/这段时间 variants also leave no residue", () => {
    expect(financeExtremeTopicTerms("近期最贵的一笔支出")).toBeNull();
    expect(financeExtremeTopicTerms("这段时间花得最多的一笔")).toBeNull();
  });
  it("real topic terms survive stripping (R174 回归)", () => {
    expect(financeExtremeTopicTerms("最近买过的键盘里最贵的是哪一把")).toEqual(["键盘"]);
  });
});

// ---- P3-2 延伸（R228 生产实测）：混合付款+退款净额句是单笔交易，
// 不能被台账聚合口径剔出极值比较 ----
describe("R228 mixed payment+refund net note participates in extreme ranking", () => {
  it("付款 34.5 其中退款 9 只有 1 行正数明细，不是台账聚合", () => {
    expect(ledgerPositiveRows("昨晚打车付款 34.5 其中退款 9")).toBe(1);
    expect(isLedgerAggregateNote({ content: "昨晚打车付款 34.5 其中退款 9", amount: 25.5 })).toBe(false);
  });
  it("多笔正数明细的含退款台账仍是聚合（R194 不回归）", () => {
    const refundLedger = { content: "早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5", amount: 420.5 };
    expect(ledgerPositiveRows(refundLedger.content)).toBe(3);
    expect(isLedgerAggregateNote(refundLedger)).toBe(true);
  });
  it("含合计行的单行台账仍是聚合（R198 不回归）", () => {
    const trip = { content: "周末出行开销：车费 46，门票 120，纪念品退款 -30，合计 224", amount: 224 };
    expect(ledgerPositiveRows(trip.content)).toBe(2);
    expect(isLedgerAggregateNote(trip)).toBe(true);
  });
});
