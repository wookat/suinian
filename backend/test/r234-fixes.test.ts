import { describe, it, expect } from "vitest";
import { buildTriagePrompt, parseLedgerTable, fixLedgerAmount, fixLedgerNetDirection } from "../src/triage";
import { scrubUnsourcedAmounts, financeTopicTerms, financeAggIntent, isFinanceAggQuestion } from "../src/ask";
import { ASK_KEYWORDS_SYSTEM } from "../src/index";
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

// ---- P2-1（audit-r233 §P2-1）：「咖啡 19 退款/退货 -25(洒了)」词形不对称
// ——退款×退货×换货×赔付冲减词形 few-shot 回流统一口径（不加正则） ----
describe("R234 P2-1 refund word-form symmetric few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("states unified word-form rule for 退款/退货/换货/赔付/退回/返现", () => {
    expect(prompt).toContain("退款/退货/换货/赔付/退回/返现」这些冲减词形全部同一口径");
  });
  it("includes the production-failing 咖啡 退款 judgement as income 6", () => {
    expect(prompt).toContain("咖啡 19 退款 -25(洒了)」→ income，amount=6");
  });
  it("includes the 咖啡 退货 word-form counterpart", () => {
    expect(prompt).toContain("咖啡 19 退货 -25(洒了)」→ income，amount=6");
  });
  it("includes the 换货 word-form judgement", () => {
    expect(prompt).toContain("文具 12 换货 -40(尺寸不对)」→ income，amount=28");
  });
  it("includes the 赔付 word-form judgement", () => {
    expect(prompt).toContain("快递 10 赔付 -35(丢件)」→ income，amount=25");
  });
  it("keeps the R232 零食 退货 judgements (不回归)", () => {
    expect(prompt).toContain("零食 8 退货 -30(质量差)");
    expect(prompt).toContain("零食8退货-30(质量差)");
  });
});

// ---- P2-1 确定性台账管线对生产原句不回归：模型判成财务类后净额仲裁锁 income 6 ----
describe("R234 P2-1 deterministic ledger pipeline on the production sentence", () => {
  const SENT = "咖啡 19 退款 -25(洒了)";
  it("parseLedgerTable nets the mixed-sign shorthand to -6", () => {
    expect(parseLedgerTable(SENT)).toEqual({ amount: -6, rows: 2 });
  });
  it("fixLedgerAmount + fixLedgerNetDirection lock expense to income 6", () => {
    const out = fixLedgerNetDirection(SENT, fixLedgerAmount(SENT, finance("expense", null)));
    expect(out.category).toBe("income");
    expect(out.amount).toBe(6);
  });
});

// ---- P2-2（audit-r233 §P2-2）：结余禁推算未覆盖乘法算式（「所以花费了
// 60 * 2 = 120」——无结余词、无币种单位）——同一 ANSWER_AMOUNT_RE 管道
// 补通用算式分支，加减乘除全形态锁定 ----
describe("R234 P2-2 unsourced arithmetic-equation scrub (全算式形态)", () => {
  const SOURCE = "游泳卡充值 800\n游泳去了两次\n每次游泳花费 60";
  it("scrubs the production multiplication equation (60 * 2 = 120)", () => {
    expect(scrubUnsourcedAmounts("每次游泳花费 60，游泳去了两次，所以花费了 60 * 2 = 120。", SOURCE)).toBe("");
  });
  it("scrubs multiplication with fullwidth × and ＝", () => {
    expect(scrubUnsourcedAmounts("合计 60 × 2 ＝ 120。", SOURCE)).toBe("");
  });
  it("scrubs addition equations without balance keywords", () => {
    expect(scrubUnsourcedAmounts("一共 800 + 60 = 860。", SOURCE)).toBe("");
  });
  it("scrubs subtraction equations without balance keywords", () => {
    expect(scrubUnsourcedAmounts("卡里应该是 800 - 120 = 680。", SOURCE)).toBe("");
  });
  it("scrubs division equations (/ and ÷)", () => {
    expect(scrubUnsourcedAmounts("平均 800 / 2 = 400。", SOURCE)).toBe("");
    expect(scrubUnsourcedAmounts("平均 800 ÷ 2 = 400。", SOURCE)).toBe("");
  });
  it("scrubs multi-operand chained equations", () => {
    expect(scrubUnsourcedAmounts("总共 60 * 2 + 800 = 920。", SOURCE)).toBe("");
  });
  it("keeps equations whose result number is sourced", () => {
    const src = `${SOURCE}\n合计花费 120`;
    expect(scrubUnsourcedAmounts("所以花费了 60 * 2 = 120。", src)).toBe("所以花费了 60 * 2 = 120。");
  });
  it("keeps sentences with sourced numbers and no equation", () => {
    expect(scrubUnsourcedAmounts("游泳卡充值了 800，每次花费 60。", SOURCE)).toBe("游泳卡充值了 800，每次花费 60。");
  });
  it("keeps the R232 balance-equation scrub behavior (同一管道不回归)", () => {
    const src232 = "剪头发的卡充了 500\n又充了 100\n剪头发用了 45";
    expect(scrubUnsourcedAmounts("还剩 500 + 100 - 45 = 555。", src232)).toBe("");
    expect(scrubUnsourcedAmounts("卡里还剩 555。", src232)).toBe("");
  });
});

// ---- P2-1 确定性兜底词形对称（生产复跑实测：「快递 10 赔付 -35(丢件)」
// 漂移成 expense 25——换货/赔付缺席冲减词形，两行短句门槛拒收致兜底不生效）----
describe("R234 P2-1 deterministic reversal-word symmetry", () => {
  const t = (category: Category): TriageResult => finance(category, 25);
  it("arbitrates 换货/赔付 net-negative short sentences to income", () => {
    expect(fixLedgerNetDirection("文具 12 换货 -40(尺寸不对)", finance("expense", 28))).toMatchObject({
      category: "income",
      amount: 28,
    });
    expect(fixLedgerNetDirection("快递 10 赔付 -35(丢件)", t("expense"))).toMatchObject({
      category: "income",
      amount: 25,
    });
  });
  it("locks the net amount for all four reversal word forms", () => {
    expect(parseLedgerTable("咖啡 19 退款 -25(洒了)")).toMatchObject({ amount: -6 });
    expect(parseLedgerTable("咖啡 19 退货 -25(洒了)")).toMatchObject({ amount: -6 });
    expect(parseLedgerTable("文具 12 换货 -40(尺寸不对)")).toMatchObject({ amount: -28 });
    expect(parseLedgerTable("快递 10 赔付 -35(丢件)")).toMatchObject({ amount: -25 });
  });
  it("does not double-flip explicit negative 赔付 note rows (R210 不回归)", () => {
    expect(parseLedgerTable("快递费,-34.5 (破损赔付)")).toBeNull();
  });
});

// ---- P3-3（audit-r233 §P3-3 生产实测）：「信用卡还了多少钱」被财务剥词
// 流水线逐字剥成「信卡还」、「杭州住宿订的哪里」整串注入 LIKE——复合名词
// 占位保护 + 「订的哪里」类事实问法路由普通召回 ----
describe("R234 P3-3 deterministic finance-term extraction fixes", () => {
  it("keeps 信用卡 intact instead of mangling to 信卡还", () => {
    expect(financeTopicTerms("信用卡还了多少钱")).toEqual(["信用卡"]);
  });
  it("protects other finance-verb-containing compounds", () => {
    expect(financeTopicTerms("交通花了多少钱")).toEqual(["交通"]);
    expect(financeTopicTerms("日用品一共花了多少钱")).toEqual(["日用品"]);
  });
  it("routes 哪里-style fact+amount compound questions to normal recall", () => {
    expect(financeAggIntent("杭州住宿订的哪里，花了多少钱")).toBeNull();
    expect(financeTopicTerms("杭州住宿订的哪里，花了多少钱")).toBeNull();
  });
  it("keeps existing aggregate/subset routing (不回归)", () => {
    expect(isFinanceAggQuestion("这个月一共花了多少钱")).toBe(true);
    expect(financeTopicTerms("咖啡一共花了多少")).toEqual(["咖啡"]);
  });
});

// ---- P3-3 抽取器提示词收口：复合名词不拆字 + 同义扩展 ----
describe("R234 P3-3 keyword-extraction prompt guards compound nouns and synonyms", () => {
  it("forbids splitting compound nouns like 信用卡", () => {
    expect(ASK_KEYWORDS_SYSTEM).toContain("信用卡」绝不能拆成「信卡");
  });
  it("expands 住宿 and 信用卡还款 synonyms", () => {
    expect(ASK_KEYWORDS_SYSTEM).toContain("住宿」也输出「民宿 酒店");
    expect(ASK_KEYWORDS_SYSTEM).toContain("信用卡 还款 账单");
  });
});
