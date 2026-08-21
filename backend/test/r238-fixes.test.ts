import { describe, it, expect } from "vitest";
import {
  needsLangNormalization,
  sanitizeNormalizedQuestion,
  ASK_NORMALIZE_SYSTEM,
} from "../src/index";
import {
  degradeAskTerms,
  degradeFinanceSubsetTerms,
  financeAggIntent,
  financeExtremeIntent,
  financeTopicTerms,
  topicCountIntent,
  parseTimeRange,
} from "../src/ask";
import { buildTriagePrompt, fixCnNumeralAmount, cnNumeralToNumber } from "../src/triage";
import type { TriageResult } from "../src/types";

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

// ---- P2（audit-r237 §3.1）：英文/中英混合财务问法归一成等义中文问句后走
// 既有确定性管道（LLM 主判 + 规则兜底，不堆英文正则族） ----
describe("R238 P2 needsLangNormalization gating", () => {
  it("triggers on pure-English questions", () => {
    expect(needsLangNormalization("What are my total expenses this month?")).toBe(true);
    expect(needsLangNormalization("How many times did I buy coffee beans?")).toBe(true);
  });
  it("triggers on mixed-language questions", () => {
    expect(needsLangNormalization("coffee beans 一共花了多少钱？")).toBe(true);
    expect(needsLangNormalization("top 3 支出是哪三笔？")).toBe(true);
  });
  it("never triggers on pure-Chinese questions (zero extra LLM call)", () => {
    expect(needsLangNormalization("这个月总支出是多少")).toBe(false);
    expect(needsLangNormalization("最贵的一笔支出")).toBe(false);
    expect(needsLangNormalization("咖啡豆一共花了多少钱")).toBe(false);
  });
  it("skips over-length questions (budget guard)", () => {
    expect(needsLangNormalization(`total expenses ${"很长".repeat(160)}`)).toBe(false);
  });
});

describe("R238 P2 sanitizeNormalizedQuestion (rule fallback on unusable output)", () => {
  const q = "What are my total expenses this month?";
  it("accepts a clean Chinese rewrite (strips wrapping quotes)", () => {
    expect(sanitizeNormalizedQuestion("这个月总支出是多少", q)).toBe("这个月总支出是多少");
    expect(sanitizeNormalizedQuestion("「这个月总支出是多少」", q)).toBe("这个月总支出是多少");
  });
  it("rejects empty / null / echoed / non-Chinese / multiline / over-long output", () => {
    expect(sanitizeNormalizedQuestion(null, q)).toBe(null);
    expect(sanitizeNormalizedQuestion("", q)).toBe(null);
    expect(sanitizeNormalizedQuestion(q, q)).toBe(null); // mock/echo → fallback to original
    expect(sanitizeNormalizedQuestion("total expenses this month", q)).toBe(null);
    expect(sanitizeNormalizedQuestion("这个月\n总支出", q)).toBe(null);
    expect(sanitizeNormalizedQuestion(`这个月总支出${"啊".repeat(200)}`, q)).toBe(null);
  });
  it("normalize prompt forbids answering / adding info and demands question-only output", () => {
    expect(ASK_NORMALIZE_SYSTEM).toContain("绝不回答问题");
    expect(ASK_NORMALIZE_SYSTEM).toContain("只输出改写后的中文问句本身");
  });
});

// 归一化后的中文问句必须命中与中文原生问法完全相同的确定性意图（audit-r237
// §3.1 十问的中文等义句逐条锁定）
describe("R238 P2 normalized Chinese equivalents hit the deterministic intents", () => {
  it("total expenses / total income this month → financeAggIntent exact", () => {
    expect(financeAggIntent("这个月总支出是多少")).toBe("exact");
    expect(financeAggIntent("这个月总收入是多少")).toBe("exact");
  });
  it("most expensive / cheapest / top 3 → financeExtremeIntent", () => {
    expect(financeExtremeIntent("最贵的一笔支出是什么")).toMatchObject({ kind: "max", direction: "expense" });
    expect(financeExtremeIntent("最便宜的一笔支出是什么")).toMatchObject({ kind: "min", direction: "expense" });
    expect(financeExtremeIntent("这个月支出最大的 3 笔是哪几笔")).toMatchObject({ kind: "max", count: 3 });
  });
  it("how much did I spend on coffee beans → finance subset topic terms", () => {
    expect(financeTopicTerms("咖啡豆一共花了多少钱")).toContain("咖啡豆");
  });
  it("how many times did I buy coffee beans → topicCountIntent", () => {
    expect(topicCountIntent("咖啡豆买了多少次")).toBe("咖啡豆");
  });
  it("between Aug 10 and Aug 20 → explicit date-range parseTimeRange", () => {
    const r = parseTimeRange("8月10日到8月20日买咖啡豆花了多少钱", NOW);
    expect(r?.phrase).toBe("8月10日到8月20日");
    expect(r?.start).toBe("2026-08-09 16:00:00"); // UTC 存储：+08:00 的 8/10 00:00
    expect(r?.end).toBe("2026-08-20 16:00:00");
  });
});

// ---- P3-3（audit-r237 P3-3）：关键词抽取过拟合致召回未命中——LIKE 零命中时
// 剥残片降级重试一次（仍是精确匹配口径，不做宽泛分词） ----
describe("R238 P2 在…上 介词框架剥离", () => {
  it("在咖啡豆上花了多少钱 → 主题词为 咖啡豆（不带尾部 上）", () => {
    expect(financeTopicTerms("我在咖啡豆上一共花了多少钱")).toEqual(["咖啡豆"]);
  });
  it("网上购物 等以上结尾的正常主题不受影响", () => {
    expect(financeTopicTerms("网购一共花了多少钱")).toEqual(["网购"]);
  });
});

describe("R238 P3-3 财务子集降级剥尾部指示残片", () => {
  it("青岛这趟 → 青岛（QA 实测：青岛这趟一共花了多少 fail-closed）", () => {
    expect(degradeFinanceSubsetTerms(["青岛这趟"])).toEqual(["青岛"]);
  });
  it("无残片时不盲目重试", () => {
    expect(degradeFinanceSubsetTerms(["青岛"])).toBe(null);
  });
});

describe("R238 P3-3 degradeAskTerms", () => {
  it("strips the audit-observed verb-echo fragment 打羽毛球打", () => {
    expect(degradeAskTerms(["打羽毛球打"])).toEqual(["打羽毛球"]);
  });
  it("strips the audit-observed demonstrative fragment 青岛这趟", () => {
    expect(degradeAskTerms(["青岛这趟"])).toEqual(["青岛"]);
  });
  it("returns null when nothing degradable (no blind retry)", () => {
    expect(degradeAskTerms(["羽毛球", "青岛"])).toBe(null);
    expect(degradeAskTerms([])).toBe(null);
  });
  it("keeps healthy terms while degrading fragments", () => {
    expect(degradeAskTerms(["修水龙头", "青岛这趟"])).toEqual(["修水龙头", "青岛"]);
  });
});

// ---- P3-1（audit-r237 P3-1）：R229「公积金补缴 3000」类目漂移——分拣提示词
// 补充社保/公积金补缴判例（transfer），不加正则 ----
describe("R238 P3-1 provident-fund top-up judgement in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the production-drifting case as transfer with amount", () => {
    expect(prompt).toContain("「公积金补缴 3000」→ transfer，amount=3000");
    expect(prompt).toContain("「社保补缴 1200」也是 transfer");
  });
  it("keeps the tax top-up counter-example as expense", () => {
    expect(prompt).toContain("「个税汇算补缴」是钱交出去不回来，仍是 expense");
  });
});

// ---- P3-2（audit-r237 P3-2）：语音中文数字金额未提取——确定性规则兜底 ----
describe("R238 P3-2 cnNumeralToNumber", () => {
  it("parses plain and compound numerals", () => {
    expect(cnNumeralToNumber("三十八")).toBe(38);
    expect(cnNumeralToNumber("一百二十")).toBe(120);
    expect(cnNumeralToNumber("两千零五")).toBe(2005);
    expect(cnNumeralToNumber("一万三千")).toBe(13000);
  });
  it("parses colloquial trailing digits (一百二 = 120)", () => {
    expect(cnNumeralToNumber("一百二")).toBe(120);
    expect(cnNumeralToNumber("三千五")).toBe(3500);
  });
  it("parses 点 decimals and rejects garbage", () => {
    expect(cnNumeralToNumber("三点五")).toBe(3.5);
    expect(cnNumeralToNumber("十点二五")).toBe(10.25);
    expect(cnNumeralToNumber("零")).toBe(null);
    expect(cnNumeralToNumber("块")).toBe(null);
  });
});

describe("R238 P3-2 fixCnNumeralAmount fallback", () => {
  const base: TriageResult = { category: "expense", tags: [], title: null, is_sensitive: false, todo_due: null, amount: null, currency: null, merchant: null };
  it("extracts the audit-failing voice amounts (simplified + traditional)", () => {
    expect(fixCnNumeralAmount("买菜花了三十八块五", base).amount).toBe(38.5);
    expect(fixCnNumeralAmount("麥當勞花了三十八塊錢", base).amount).toBe(38);
    expect(fixCnNumeralAmount("打车花了十五元", base).amount).toBe(15);
    expect(fixCnNumeralAmount("午饭二十块半", base).amount).toBe(20.5);
  });
  it("sets CNY currency on extraction", () => {
    expect(fixCnNumeralAmount("买菜花了三十八块五", base).currency).toBe("CNY");
  });
  it("never overrides a model-provided amount", () => {
    expect(fixCnNumeralAmount("买菜花了三十八块五", { ...base, amount: 40 }).amount).toBe(40);
  });
  it("only applies to finance categories", () => {
    expect(fixCnNumeralAmount("视频讲了三十八块五的故事", { ...base, category: "idea" }).amount).toBe(null);
  });
  it("stays null on ambiguity (multiple amounts) — never guesses", () => {
    expect(fixCnNumeralAmount("早饭十块钱午饭二十块钱", base).amount).toBe(null);
  });
  it("ignores approximations / ordinals / measure words", () => {
    expect(fixCnNumeralAmount("花了几十块吧记不清了", base).amount).toBe(null);
    expect(fixCnNumeralAmount("和朋友一块去超市了", base).amount).toBe(null);
    expect(fixCnNumeralAmount("第一块奖牌到手", { ...base, category: "income" }).amount).toBe(null);
  });
  it("still extracts 一块五 / 一块钱 (single-yuan with explicit money marker)", () => {
    expect(fixCnNumeralAmount("公交一块五", base).amount).toBe(1.5);
    expect(fixCnNumeralAmount("称了个袋子一块钱", base).amount).toBe(1);
  });
});
