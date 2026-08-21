import { describe, it, expect } from "vitest";
import { buildTriagePrompt, fixFinanceDirection } from "../src/triage";
import {
  parseTimeRange,
  financeExtremeIntent,
  financeExtremeTopicTerms,
  financeTopicTerms,
  buildFinanceExtremeAnswer,
  scrubUnsourcedAmounts,
} from "../src/ask";
import type { FinanceExtremeQuery } from "../src/ask";

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

// ---- P2-1（audit-r235 §5）：孤立「赔付了 15 元」被判 expense——赔付方向
// 双语境 few-shot 回流（不加正则）：别人赔我=income / 我赔别人=expense ----
describe("R236 P2-1 compensation direction few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("states the direction rule keyed on who compensates whom", () => {
    expect(prompt).toContain("「赔付/赔偿/理赔」按谁赔谁判方向");
    expect(prompt).toContain("默认是用户收到赔付＝income");
  });
  it("includes the production-failing isolated 赔付 judgement as income", () => {
    expect(prompt).toContain("商家超时赔付了 15 元」→ income，amount=15");
    expect(prompt).toContain("「赔付了 15 元」→ income，amount=15");
  });
  it("includes the opposite context: user compensating someone = expense", () => {
    expect(prompt).toContain("赔付了店家 60 元」→ expense，amount=60");
    expect(prompt).toContain("赔了对方 500」→ expense，amount=500");
  });
  it("keeps the R234 ledger-reduction 赔付 judgement (不回归)", () => {
    expect(prompt).toContain("快递 10 赔付 -35(丢件)」→ income，amount=25");
  });
});

// 真实根因：fixFinanceDirection 词面兜底把「赔付了」误当「付了」支出证据，
// 将模型正确的 income 确定性翻成 expense——「赔付」必须排除出支出词面
describe("R236 P2-1 fixFinanceDirection must not flip 赔付 income", () => {
  const base = { category: "income" as const, tags: [], title: null, is_sensitive: false, todo_due: null, amount: 15, currency: "CNY", merchant: null, is_question: false };
  it("keeps model income for isolated 赔付了 (no flip to expense)", () => {
    expect(fixFinanceDirection("商家超时赔付了 15 元", base).category).toBe("income");
    expect(fixFinanceDirection("赔付了 15 元", base).category).toBe("income");
  });
  it("keeps model expense when user compensates someone", () => {
    const exp = { ...base, category: "expense" as const, amount: 60 };
    expect(fixFinanceDirection("打碎了店里的杯子，赔付了店家 60 元", exp).category).toBe("expense");
  });
  it("still flips genuine 付了 expense evidence (不回归)", () => {
    expect(fixFinanceDirection("付了这个月房租 2600", { ...base, amount: 2600 }).category).toBe("expense");
  });
});

// ---- P3-1（audit-r235 §6）：「火车票改签差价退回 37.5」被判 transfer ----
describe("R236 P3-1 fare-difference refund few-shot", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the 差价退回 judgement as income", () => {
    expect(prompt).toContain("火车票改签差价退回 37.5」→ income，amount=37.5");
  });
});

// ---- P3-2（audit-r235 §6）：发票 OCR 文本被判 data、amount=null ----
describe("R236 P3-2 invoice OCR few-shot", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("states invoices/receipts are transaction records, not data", () => {
    expect(prompt).toContain("绝不因为是凭证资料就归 data");
  });
  it("includes the production-failing invoice judgement", () => {
    expect(prompt).toContain("家电发票 洗衣机一台 金額：2199 元」→ expense，amount=2199");
  });
});

// ---- P3-3（audit-r235 §6）：中文数字语音金额未提取 ----
describe("R236 P3-3 Chinese-numeral amount few-shot", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("states Chinese numerals must be converted, not nulled", () => {
    expect(prompt).toContain("金额写成中文数字时同样要换算成阿拉伯数字提取");
  });
  it("includes conversion judgements", () => {
    expect(prompt).toContain("买菜花了三十八块五」→ expense，amount=38.5");
    expect(prompt).toContain("收到红包两百」→ income，amount=200");
  });
});

// ---- P3-4（audit-r235 §6）：「8月10号到8月20号之间」时间窗落空 ----
describe("R236 P3-4 explicit date-range parsing", () => {
  it("parses M月D号到M月D号之间 as a Shanghai-day closed-open range", () => {
    const r = parseTimeRange("8月10号到8月20号之间买咖啡豆花了多少", NOW);
    expect(r).not.toBeNull();
    expect(r!.start).toBe("2026-08-09 16:00:00");
    expect(r!.end).toBe("2026-08-20 16:00:00"); // 8/20 inclusive → exclusive 8/21 SH midnight
  });
  it("parses a single explicit date as that day", () => {
    const r = parseTimeRange("8月10号买了什么", NOW);
    expect(r!.start).toBe("2026-08-09 16:00:00");
    expect(r!.end).toBe("2026-08-10 16:00:00");
  });
  it("parses cross-month ranges with a second month", () => {
    const r = parseTimeRange("7月28号到8月3号之间的支出", NOW);
    expect(r!.start).toBe("2026-07-27 16:00:00");
    expect(r!.end).toBe("2026-08-03 16:00:00");
  });
  it("parses Chinese-numeral dates", () => {
    const r = parseTimeRange("八月十号到八月二十号花了多少", NOW);
    expect(r!.start).toBe("2026-08-09 16:00:00");
    expect(r!.end).toBe("2026-08-20 16:00:00");
  });
  it("takes last year for future months (same口径 as bare X月)", () => {
    const r = parseTimeRange("12月5号到12月8号的开销", NOW);
    expect(r!.start).toBe("2025-12-04 16:00:00");
  });
  it("strips the date-range wording from finance topic terms (no 到之间 residue)", () => {
    expect(financeTopicTerms("8月10号到8月20号之间买咖啡豆花了多少")).toEqual(["咖啡豆"]);
  });
  it("keeps bare-month parsing unchanged (不回归)", () => {
    const r = parseTimeRange("6月花了多少", NOW);
    expect(r!.start).toBe("2026-05-31 16:00:00");
    expect(r!.end).toBe("2026-06-30 16:00:00");
  });
});

// ---- P2-3（audit-r235 §5）：Top-3 支出排序完全错误——Top-N 并入与单极值/
// 序数同一 ORDER BY amount 确定性管道 ----
describe("R236 P2-3 Top-N finance intent", () => {
  it("recognizes 支出最多的三笔 as expense max count=3", () => {
    const q = financeExtremeIntent("这个月支出最多的三笔是什么");
    expect(q).toMatchObject({ kind: "max", direction: "expense", rank: 1, count: 3 });
  });
  it("recognizes 前 N 笔 wording", () => {
    const q = financeExtremeIntent("最贵的前 5 笔支出是哪些");
    expect(q).toMatchObject({ kind: "max", direction: "expense", count: 5 });
  });
  it("recognizes income Top-N", () => {
    const q = financeExtremeIntent("收入最多的两笔是什么");
    expect(q).toMatchObject({ kind: "max", direction: "income", count: 2 });
  });
  it("recognizes min-side Top-N", () => {
    const q = financeExtremeIntent("花得最少的三笔是哪三笔");
    expect(q).toMatchObject({ kind: "min", direction: "expense", count: 3 });
  });
  it("works with a time window", () => {
    const q = financeExtremeIntent("上个月支出最多的三笔");
    expect(q).toMatchObject({ kind: "max", direction: "expense", count: 3 });
    expect(parseTimeRange("上个月支出最多的三笔", NOW)).not.toBeNull();
  });
  it("keeps single extreme unchanged (count absent)", () => {
    const q = financeExtremeIntent("最贵的一笔支出是什么");
    expect(q).toMatchObject({ kind: "max", direction: "expense", rank: 1 });
    expect(q!.count).toBeUndefined();
  });
  it("keeps ordinal rank unchanged (不回归)", () => {
    const q = financeExtremeIntent("第二贵的支出是哪笔");
    expect(q).toMatchObject({ kind: "max", rank: 2 });
    expect(q!.count).toBeUndefined();
  });
  it("leaves no Top-N wording residue in extreme topic terms", () => {
    expect(financeExtremeTopicTerms("这个月支出最多的三笔是什么")).toBeNull();
    expect(financeExtremeTopicTerms("咖啡里花得最多的三笔")).toEqual(["咖啡"]);
  });
});

describe("R236 P2-3 Top-N deterministic answer", () => {
  const query: FinanceExtremeQuery = { kind: "max", direction: "expense", rank: 1, count: 3 };
  const rows = [
    { id: "a", title: "车位", content: "车位 4200", created_at: "2026-08-05 04:00:00", is_sensitive: 0, amount: 4200, currency: "CNY" },
    { id: "b", title: "显示器", content: "显示器 1450", created_at: "2026-08-06 04:00:00", is_sensitive: 0, amount: 1450, currency: "CNY" },
    { id: "c", title: "酒店", content: "酒店 960", created_at: "2026-08-07 04:00:00", is_sensitive: 0, amount: 960, currency: "CNY" },
  ];
  it("lists the N rows in ranked order with per-rank numbering", () => {
    const md = buildFinanceExtremeAnswer(query, rows, 0, "本月");
    const iCar = md.indexOf("4200");
    const iMon = md.indexOf("1450");
    const iHotel = md.indexOf("960");
    expect(iCar).toBeGreaterThan(-1);
    expect(iCar).toBeLessThan(iMon);
    expect(iMon).toBeLessThan(iHotel);
    expect(md).toContain("金额最大的 3 笔");
    expect(md).toContain("1. CNY");
    expect(md).toContain("3. CNY");
    expect(md).toContain("排序取前 3 名");
  });
  it("states shortfall honestly when fewer rows exist than requested", () => {
    const md = buildFinanceExtremeAnswer(query, rows.slice(0, 2), 0, "本月", null, 0, [{ currency: "CNY", count: 2 }]);
    expect(md).toContain("不足 3 笔，按实有条数列出");
  });
  it("keeps single-extreme answer wording unchanged (不回归)", () => {
    const md = buildFinanceExtremeAnswer({ kind: "max", direction: "expense", rank: 1 }, rows.slice(0, 1), 0, "本月");
    expect(md).toContain("金额最大的一笔支出是");
  });
});

// ---- P3-6（audit-r235 §6）：「还剩 10 - 3 = 7 节」逃过禁推算——结果数撞上
// 上下文元数据头（[n] 角标/id/时间戳）里的偶发数字被误判有源；副文本改为
// 只含标题/正文后，无源结果数必须被剥除 ----
describe("R236 P3-6 equation result vs metadata digits", () => {
  it("scrubs a count equation whose result only appears in metadata-like text", () => {
    const bodySource = "问题\n羽毛球课 10 节，已经上了 3 节";
    expect(scrubUnsourcedAmounts("还剩 10 - 3 = 7 节。", bodySource)).toBe("");
  });
  it("keeps equations whose result is written in the note body", () => {
    const bodySource = "羽毛球课还剩 7 节（10 节上了 3 节）";
    expect(scrubUnsourcedAmounts("还剩 10 - 3 = 7 节。", bodySource)).toBe("还剩 10 - 3 = 7 节。");
  });
});
