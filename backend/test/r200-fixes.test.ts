// R200（audit-r199）：
// P2-1 金额 token 不作主题词 + 验证式金额前提问法（「最贵的一笔支出是
//      400 元吗」）走极值路由并按精确查询结果如实答是/否；整数×小数×
//      带币种变体全锁住。同根因家族：量词短语尾巴（「车厘子买几斤」
//      「咖啡机除垢剂一次」）剥掉后留名词主题注入 LIKE。
// P3-1 否定话术引入未出现实体（「没有提到手机壳是在淘宝买的」）——
//      输出侧确定性后校验：否定分句宾语含问句与片段中都不存在的
//      实体串时改写成通用指代，绝不编造实体。
import { describe, it, expect } from "vitest";
import type { NoteRow } from "../src/types";
import {
  financeExtremeIntent,
  financeExtremeTopicTerms,
  financeExtremePremise,
  buildFinanceExtremeAnswer,
  financeTopicTerms,
  financeShortTopicTerms,
  scrubUnsourcedNegations,
} from "../src/ask";

const note = (extra: Partial<NoteRow>): Pick<NoteRow, "id" | "title" | "content" | "created_at" | "is_sensitive" | "amount" | "currency"> => ({
  id: "n1",
  title: "空气炸锅",
  content: "买了空气炸锅 459",
  created_at: "2026-08-01 08:00:00",
  is_sensitive: 0 as unknown as NoteRow["is_sensitive"],
  amount: 459,
  currency: "CNY",
  ...extra,
});

describe("金额 token 不作主题词 (R200 P2-1)", () => {
  it("整数金额前提问法：金额不进主题词（audit-r199 生产原文）", () => {
    const q = "我最贵的一笔支出是 400 元吗？";
    expect(financeExtremeIntent(q)).toMatchObject({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeTopicTerms(q)).toBeNull();
  });
  it("小数金额形态照旧无主题词", () => {
    expect(financeExtremeTopicTerms("最贵的一笔支出是 368.5 元吗？")).toBeNull();
  });
  it("币种词变体（块/块钱/人民币/美元）均不作主题词", () => {
    for (const q of [
      "最贵的一笔支出是 400 块吗",
      "最贵的一笔支出是 400 块钱吗",
      "最贵的一笔支出是 400 人民币吗",
      "最贵的一笔支出是 25 美元吗",
    ]) {
      expect(financeExtremeTopicTerms(q)).toBeNull();
    }
  });
  it("金额前提 + 真主题限定：主题词保留、金额剥除", () => {
    expect(financeExtremeTopicTerms("键盘里最贵的一把是 400 元吗")).toEqual(["键盘"]);
  });
  it("既有主题限定问法不回归", () => {
    expect(financeExtremeTopicTerms("我买过的键盘里最贵的是哪一把")).toEqual(["键盘"]);
  });
});

describe("验证式金额前提解析 (R200 P2-1)", () => {
  it("整数/小数/币种变体", () => {
    expect(financeExtremePremise("最贵的一笔支出是 400 元吗")).toEqual({ amount: 400, currency: "CNY" });
    expect(financeExtremePremise("最贵的一笔支出是 368.5 元吗")).toEqual({ amount: 368.5, currency: "CNY" });
    expect(financeExtremePremise("最贵的一笔支出是 400 块吗")).toEqual({ amount: 400, currency: "CNY" });
    expect(financeExtremePremise("最贵的一笔是 25 美元吗")).toEqual({ amount: 25, currency: "USD" });
    expect(financeExtremePremise("最贵的一笔支出是不是 400")).toEqual({ amount: 400, currency: null });
  });
  it("无语气助词且无「是不是/是否」的数字不是前提（序数/时间数字不误判）", () => {
    expect(financeExtremePremise("金额第 2 大的支出是哪笔")).toBeNull();
    expect(financeExtremePremise("2026年7月最贵的支出是哪笔")).toBeNull();
    expect(financeExtremePremise("最贵的一笔支出是多少钱")).toBeNull();
  });
  it("premise 随 financeExtremeIntent 返回", () => {
    expect(financeExtremeIntent("最贵的一笔支出是 400 元吗")?.premise).toEqual({ amount: 400, currency: "CNY" });
    expect(financeExtremeIntent("最贵的一笔支出是哪笔")?.premise).toBeUndefined();
  });
});

describe("验证式提问的是/否直答 (R200 P2-1)", () => {
  const q400 = financeExtremeIntent("最贵的一笔支出是 400 元吗")!;
  it("前提与极值不符：如实答「不是」并给出真值", () => {
    const md = buildFinanceExtremeAnswer(q400, [note({})], 0, null);
    expect(md.startsWith("不是。")).toBe(true);
    expect(md).toContain("¥459");
  });
  it("前提与极值相符：答「是的」", () => {
    const md = buildFinanceExtremeAnswer(q400, [note({ amount: 400, content: "吉他课交学费 400" })], 0, null);
    expect(md.startsWith("是的。")).toBe(true);
  });
  it("小数前提相符", () => {
    const q = financeExtremeIntent("最贵的一笔支出是 368.5 元吗")!;
    const md = buildFinanceExtremeAnswer(q, [note({ amount: 368.5 })], 0, null);
    expect(md.startsWith("是的。")).toBe(true);
  });
  it("外币前提对上对应币种行", () => {
    const q = financeExtremeIntent("最贵的一笔支出是 25 美元吗")!;
    const rows = [note({}), note({ id: "n2", amount: 25, currency: "USD" })];
    const md = buildFinanceExtremeAnswer(q, rows, 0, null);
    expect(md.startsWith("是的。")).toBe(true);
  });
  it("多币种且前提未带币种：不强判是/否", () => {
    const q = financeExtremeIntent("最贵的一笔支出是不是 400")!;
    const rows = [note({}), note({ id: "n2", amount: 25, currency: "USD" })];
    const md = buildFinanceExtremeAnswer(q, rows, 0, null);
    // premise.currency null → 默认与 CNY 行比较，459 ≠ 400 → 不是
    expect(md.startsWith("不是。")).toBe(true);
  });
  it("无前提问法答案不带是/否前缀（不回归）", () => {
    const q = financeExtremeIntent("最贵的一笔支出是哪笔")!;
    const md = buildFinanceExtremeAnswer(q, [note({})], 0, null);
    expect(md.startsWith("是的")).toBe(false);
    expect(md.startsWith("不是")).toBe(false);
  });
});

describe("量词短语尾巴剥离 (R200 P2-1 同根因家族)", () => {
  it("「车厘子买了几斤花了多少钱」→ 主题「车厘子」", () => {
    expect(financeTopicTerms("车厘子买了几斤花了多少钱")).toEqual(["车厘子"]);
  });
  it("「咖啡机除垢剂多少钱？一次用多少？」→ 主题「咖啡机除垢剂」（「用…多少」含财务词走 financeTopicTerms）", () => {
    expect(financeTopicTerms("咖啡机除垢剂多少钱？一次用多少？")).toEqual(["咖啡机除垢剂"]);
  });
  it("既有短问法不回归", () => {
    expect(financeShortTopicTerms("车厘子多少钱")).toEqual(["车厘子"]);
  });
  it("「一次性纸杯」这类以量词开头的商品名不被剥断", () => {
    expect(financeShortTopicTerms("一次性纸杯多少钱")).toEqual(["一次性纸杯"]);
  });
});

describe("否定话术实体后校验 (R200 P3-1)", () => {
  const src1 = "手机壳是在哪里买的？\n换了新手机壳，图案是山水画";
  const src2 = "野餐是在哪个公园？\n周末去公园野餐了";
  it("生产残留例 1：引入「淘宝」被改写成通用指代", () => {
    const out = scrubUnsourcedNegations("没找到。[1] 没有提到手机壳是在淘宝买的。", src1);
    expect(out).not.toContain("淘宝");
    expect(out).toContain("没有提到");
  });
  it("生产残留例 2：引入「人民公园」被改写，转折后半句保留", () => {
    const out = scrubUnsourcedNegations("[1] 没有提到具体是人民公园，但提到周末去公园野餐了。", src2);
    expect(out).not.toContain("人民公园");
    expect(out).toContain("但提到周末去公园野餐了");
  });
  it("复述问句/片段实体的否定话术原样保留", () => {
    const ans = "[1] 没有提到手机壳是在哪里买的。";
    expect(scrubUnsourcedNegations(ans, src1)).toBe(ans);
  });
  it("泛指属性名词（价格/品牌等）不算编造实体", () => {
    const ans = "[1] 没有提到手机壳的价格。";
    expect(scrubUnsourcedNegations(ans, src1)).toBe(ans);
  });
  it("肯定句不受影响", () => {
    const ans = "手机壳的图案是山水画 [1]。";
    expect(scrubUnsourcedNegations(ans, src1)).toBe(ans);
  });
});
