import type { Env, NoteRow } from "./types";
import { formatAmount, type FinanceStats } from "./reports";
import { chatComplete } from "./ai";
import { parseLedgerTable, ledgerRowsMatching } from "./triage";

/**
 * Helpers for /api/ask retrieval quality (R54): deterministic time-range
 * parsing for time-scoped questions, refusal detection, and the explicit
 * "没找到" response with nearby suggestions.
 */

const SH_OFFSET_MS = 8 * 3600_000;

/** Format a Date as the UTC "YYYY-MM-DD HH:MM:SS" string D1 stores in created_at. */
function toUtcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Midnight (Asia/Shanghai) `days` days after the Shanghai-local date of `now`, as a UTC Date. */
function shanghaiMidnight(now: Date, days: number): Date {
  const sh = new Date(now.getTime() + SH_OFFSET_MS);
  const base = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + days);
  return new Date(base - SH_OFFSET_MS);
}

/** First day (Shanghai midnight) of the month `monthsAgo` months before `now`, as a UTC Date. */
function shanghaiMonthStart(now: Date, monthsAgo: number): Date {
  const sh = new Date(now.getTime() + SH_OFFSET_MS);
  const base = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth() - monthsAgo, 1);
  return new Date(base - SH_OFFSET_MS);
}

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };

function parseNum(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s in CN_NUM) return CN_NUM[s];
  if (s.length === 2 && s[0] === "十" && s[1] in CN_NUM) return 10 + CN_NUM[s[1]];
  if (s.length === 2 && s[0] in CN_NUM && s[1] === "十") return CN_NUM[s[0]] * 10;
  return null;
}

export interface TimeRange {
  /** inclusive lower bound, UTC "YYYY-MM-DD HH:MM:SS" */
  start: string | null;
  /** exclusive upper bound, UTC "YYYY-MM-DD HH:MM:SS" */
  end: string | null;
  /** the phrase that produced the range, for logging/debugging */
  phrase: string;
}

/**
 * Parse an explicit time scope out of a (rewritten) question: 今天/昨天/前天、
 * 这几天、最近N天/周/个月、本周/上周、本月/上个月、N个月前、去年/今年、X月.
 * Returns null when the question has no recognizable time phrase — recall is
 * then unrestricted. Dates use Asia/Shanghai day boundaries, output bounds are
 * the UTC strings D1 stores in created_at.
 */
export function parseTimeRange(question: string, now: Date = new Date()): TimeRange | null {
  const q = question;
  let m: RegExpMatchArray | null;

  if (/今天|今日/.test(q)) return { start: toUtcSql(shanghaiMidnight(now, 0)), end: null, phrase: "今天" };
  if (/昨天|昨日/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -1)), end: toUtcSql(shanghaiMidnight(now, 0)), phrase: "昨天" };
  if (/前天/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -2)), end: toUtcSql(shanghaiMidnight(now, -1)), phrase: "前天" };
  if (/这几天|最近几天|近几天/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -6)), end: null, phrase: "这几天" };

  // 最近/过去 N 天|周|个月 (rolling window ending now)
  if ((m = q.match(/(?:最近|近|过去)\s*(\d+|[一两二三四五六七八九十半]{1,2})\s*(天|日|周|星期|个?月|年)/))) {
    const n = parseNum(m[1]);
    if (n !== null) {
      const unitDays = /天|日/.test(m[2]) ? 1 : /周|星期/.test(m[2]) ? 7 : /月/.test(m[2]) ? 30 : 365;
      return { start: toUtcSql(shanghaiMidnight(now, -Math.round(n * unitDays))), end: null, phrase: m[0] };
    }
  }
  if (/最近一周|最近1周/.test(q)) return { start: toUtcSql(shanghaiMidnight(now, -7)), end: null, phrase: "最近一周" };

  // 本周/这周 (since Monday) and 上周 (previous Mon..Sun)
  if (/本周|这周|这一?周/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const dow = (sh.getUTCDay() + 6) % 7; // Monday=0
    return { start: toUtcSql(shanghaiMidnight(now, -dow)), end: null, phrase: "本周" };
  }
  if (/上周|上一?周|上个?星期/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const dow = (sh.getUTCDay() + 6) % 7;
    return {
      start: toUtcSql(shanghaiMidnight(now, -dow - 7)),
      end: toUtcSql(shanghaiMidnight(now, -dow)),
      phrase: "上周",
    };
  }

  if (/本月|这个?月/.test(q)) return { start: toUtcSql(shanghaiMonthStart(now, 0)), end: null, phrase: "本月" };
  if (/上个?月/.test(q))
    return { start: toUtcSql(shanghaiMonthStart(now, 1)), end: toUtcSql(shanghaiMonthStart(now, 0)), phrase: "上个月" };

  // N 个月前 / N 个多月前: a window around that time (fuzzy human memory)
  if ((m = q.match(/(\d+|[一两二三四五六七八九十]{1,2})\s*个?多?月(?:多)?(?:之|以)?前/))) {
    const n = parseNum(m[1]);
    if (n !== null) {
      const center = n * 30;
      return {
        start: toUtcSql(shanghaiMidnight(now, -(center + 20))),
        end: toUtcSql(shanghaiMidnight(now, -(center - 20))),
        phrase: m[0],
      };
    }
  }

  if (/去年/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const y = sh.getUTCFullYear() - 1;
    return {
      start: toUtcSql(new Date(Date.UTC(y, 0, 1) - SH_OFFSET_MS)),
      end: toUtcSql(new Date(Date.UTC(y + 1, 0, 1) - SH_OFFSET_MS)),
      phrase: "去年",
    };
  }
  if (/今年/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    return { start: toUtcSql(new Date(Date.UTC(sh.getUTCFullYear(), 0, 1) - SH_OFFSET_MS)), end: null, phrase: "今年" };
  }

  // bare "X月" (e.g. 6月/十月/"7 月"): that month of the current year, or last year if in the future
  if ((m = q.match(/(?:^|[^0-9个半上这本])(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底)?/))) {
    const n = parseNum(m[1]);
    if (n !== null && n >= 1 && n <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = n - 1 > sh.getUTCMonth() ? sh.getUTCFullYear() - 1 : sh.getUTCFullYear();
      return {
        start: toUtcSql(new Date(Date.UTC(y, n - 1, 1) - SH_OFFSET_MS)),
        end: toUtcSql(new Date(Date.UTC(y, n, 1) - SH_OFFSET_MS)),
        phrase: m[0].trim(),
      };
    }
  }
  return null;
}

// ---- 财务聚合问答（R107 P1-2）----
// 「X 时间一共花了多少钱」类合计问题必须走 SQL 精确聚合（与周报/月报同一
// financeStats 口径），绝不能靠 LLM 对被 LIMIT 截断的召回片段心算。

export const FINANCE_WORD_RE = /花了?|花销|花费|支出|开支|消费|开销|收入|进账|入账|结余|收支|余额|记了?账|账单|赚了?|挣了?|用掉|缴费|交费|[缴交用]了?(?=[^？?。]{0,10}(?:多少|几))/;
const AGG_WORD_RE = /一共|总共|合计|总计|共计|加起来|多少钱|多少笔|几笔|平均每|总额|结余|收支|余额|多少|怎么样|怎样|如何|情况/;
// sum-style wording that only makes sense as a books-level aggregate: when it
// appears with a finance word but the question can't be routed to the exact
// aggregate (extra qualifiers remain), the LLM must NOT mental-math it.
const STRONG_AGG_RE = /一共|总共|合计|总计|共计|加起来|平均每|总额|结余|收支|余额/;
// strip time phrases / finance verbs / aggregation words / filler; whatever
// meaningful text remains means the question is about a specific item
// ("买咖啡花了多少钱"), not an overall aggregate — fall through to normal ask.
const STRIP_RES: RegExp[] = [
  /今天|今日|昨天|昨日|前天|这几天|最近几天|近几天|(?:最近|近|过去)\s*(?:\d+|[一两二三四五六七八九十半]{1,2})\s*(?:天|日|周|星期|个?月|年)|本周|这一?周|这周|上一?周|上个?星期|上周|本月|这个?月|上个?月|去年|今年|(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底)?/g,
  /一共|总共|合计|总计|共计|加起来|平均每天|平均|多少钱|多少笔|几笔|多少|总额|怎么样|怎样|如何|情况/g,
  /花了?|花销|花费|支出|开支|消费|开销|收入|进账|入账|结余|收支|余额|记了?账|账单|赚了?|挣了?|用掉|[缴交用]了?|钱/g,
  /请问|大概|大约|一下|来着|帮我算|算算|统计|我的?|了|吗|呢|啊|呀|哦|是|都|在|有|和|与|？|\?|，|,|。|、|\s/g,
];

/** True when the question asks for an overall finance aggregate (not a specific item's price). */
export function isFinanceAggQuestion(question: string): boolean {
  if (!FINANCE_WORD_RE.test(question) || !AGG_WORD_RE.test(question)) return false;
  let residual = question;
  for (const re of STRIP_RES) residual = residual.replace(re, "");
  return residual.length < 2;
}

/**
 * How /api/ask should answer a finance question (R109 P1):
 * - "exact": overall aggregate — answer from financeStats, never the LLM.
 * - "fail_closed": aggregate wording but extra qualifiers remain ("咖啡一共
 *   花了多少") — the exact path can't scope it, and the LLM would mental-math
 *   truncated recall (and may mix currencies). Refuse the arithmetic and show
 *   the exact overall stats instead.
 * - null: not an aggregate question (single-item price etc.) — normal ask.
 */
// Fact-seeking wording: the user wants details from specific notes (names,
// which ones, when), not a books-level sum. Compound questions like「买的两本
// 书叫什么，一共花了多少钱」must reach normal recall so the notes themselves
// answer both parts — fail-closing them hides the answer (R117 P2-1).
const FACT_QUERY_RE = /叫什么|是什么|什么名|名字|哪几?[本个件家部条]|哪些|分别|各是|什么时候|在哪|为什么|依据/;

export function financeAggIntent(question: string): "exact" | "fail_closed" | null {
  // 「它花了多少钱」问的是某个具体事物的价格，不是全账聚合：代词剥词后残留
  // 不足 2 字会被误判成 exact（R186 P1 根因），指代问法一律走普通召回。
  if (ASK_PRONOUN_REF_RE.test(question)) return null;
  if (isFinanceAggQuestion(question)) return "exact";
  if (FACT_QUERY_RE.test(question)) return null;
  if (FINANCE_WORD_RE.test(question) && STRONG_AGG_RE.test(question)) return "fail_closed";
  return null;
}

// ---- 财务比较（R168 P1）----
// 「赚得多还是花得多/入不敷出/收支差多少」这类收支比较问题与合计同理：
// 必须基于 financeStats 的 SQL 精确聚合做比较后确定性措辞，绝不让 LLM 对
// 被 LIMIT 截断的召回结果自由加总再比较（R167 实测漏项算错总支出）。

const FINANCE_BALANCE_RES: RegExp[] = [
  // 「赚得多还是花得多」「花得多还是挣得少」等还是式二选一
  /[赚挣收][得的了]?[多少]还是[花支][得的出了]?[多少]|[花支][得的出了]?[多少]还是[赚挣收][得的入了]?[多少]/,
  /收入[多少]还是支出[多少]|支出[多少]还是收入[多少]|收入还是支出多|支出还是收入多/,
  // 「花得比赚得多」「是不是花的比挣的多」比较句式
  /[花支][得的出]?比[赚挣收][得的入]?[多少]|[赚挣收][得的入]?比[花支][得的出]?[多少]/,
  // 固定说法：入不敷出/超支/收支倒挂/是赚是亏
  /入不敷出|收不抵支|支大于收|收大于支|收支倒挂|超支|花超/,
  /赚了还是亏了|亏了还是赚了|是赚是亏|亏钱了[吗么]|亏损了[吗么]/,
  // 收支差值：「收支差多少」「收入和支出差多少/差额」
  /收支差(?:了|额|值)?(?:是)?多少|收入和支出(?:的)?差(?:多少|额|值)|收入支出差多少/,
  /(?:收入|支出)[^？?。]{0,6}(?:哪个多|谁多|差多少|差额|差值)/,
];

/** 识别收支比较问题（同期收入 vs 支出）；非此类返回 false。 */
export function financeCompareIntent(question: string): boolean {
  // 「哪个多/谁多」是比较措辞而非事实查询，先摘除再过事实问题闸门
  const probe = question.replace(/哪个多|谁多/g, "");
  if (FACT_QUERY_RE.test(probe)) return false;
  return FINANCE_BALANCE_RES.some((re) => re.test(question));
}

// 环比/上期对比：本期与上期两个窗口各自 SQL 聚合后比较。识别条件从严：
// 必须出现「环比」，或同句同时出现本期+上期时间词，或「比上个月/比上周」
// 这类明确的跨期比较措辞——「上个月结余多少」这类单期合计绝不落入。
const MOM_EXPLICIT_RE = /环比/;
const MOM_VS_PREV_MONTH_RE = /(?:比|较|跟|和|同)上个?月(?:比|相比)?|上个?月(?:比|较|跟|和|同)(?:这个?月|本月)/;
const MOM_VS_PREV_WEEK_RE = /(?:比|较|跟|和|同)上个?(?:周|星期)(?:比|相比)?|上个?(?:周|星期)(?:比|较|跟|和|同)(?:这个?周|本周)/;

/** 识别财务环比/跨期比较问题，返回比较窗口单位；非此类返回 null。 */
export function financeMomIntent(question: string): "month" | "week" | null {
  if (FACT_QUERY_RE.test(question)) return null;
  if (!FINANCE_WORD_RE.test(question)) return null;
  if (MOM_EXPLICIT_RE.test(question)) return /周|星期/.test(question) ? "week" : "month";
  if (MOM_VS_PREV_WEEK_RE.test(question)) return "week";
  if (MOM_VS_PREV_MONTH_RE.test(question)) return "month";
  const hasCurMonth = /本月|这个?月/.test(question);
  const hasPrevMonth = /上个?月/.test(question);
  const hasCurWeek = /本周|这个?周|这一?周/.test(question);
  const hasPrevWeek = /上个?周|上一?周|上个?星期/.test(question);
  if (hasCurWeek && hasPrevWeek) return "week";
  if (hasCurMonth && hasPrevMonth) return "month";
  return null;
}

/** 收支比较的确定性答案：按币种分别比较（不同币种金额不可直接比较）。 */
export function buildFinanceCompareAnswer(stats: FinanceStats, phrase: string | null): string {
  const scope = phrase ?? "全部笔记";
  if (stats.expenseCount === 0 && stats.incomeCount === 0) {
    const transferNote = stats.transferCount > 0 ? `另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支。` : "";
    return `${scope}没有记账记录（支出/收入均为 0 笔），无法比较收支。${transferNote}\n\n以上为精确统计，口径与周报/月报一致。`;
  }
  const entries = Object.entries(stats.totals);
  const lines = entries.map(([cur, t]) => {
    const diff = t.income - t.expense;
    const verdict =
      diff > 0
        ? `收入比支出多 ${formatAmount(diff, cur)}（赚得多）`
        : diff < 0
          ? `支出比收入多 ${formatAmount(-diff, cur)}（花得多）`
          : "收支持平";
    return `- ${cur}：收入 ${formatAmount(t.income, cur)}，支出 ${formatAmount(t.expense, cur)}，${verdict}`;
  });
  let head: string;
  if (entries.length === 1) {
    const [, t] = entries[0];
    const diff = t.income - t.expense;
    head = diff > 0 ? `${scope}你赚得多：` : diff < 0 ? `${scope}你花得多：` : `${scope}你的收支持平：`;
  } else {
    head = `${scope}的收支按币种分别比较（不同币种金额不可直接比较）：`;
  }
  let md = `${head}\n${lines.join("\n")}\n共 ${stats.expenseCount} 笔支出、${stats.incomeCount} 笔收入。`;
  if (stats.unknownAmount > 0) md += `\n（另有 ${stats.unknownAmount} 笔未识别出金额，未计入比较。）`;
  if (stats.transferCount > 0) md += `\n（另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支。）`;
  md += `\n\n以上为精确统计，口径与周报/月报一致。`;
  return md;
}

/** 环比比较的确定性答案：本期与上期各自精确聚合后按币种对比。 */
export function buildFinanceMomAnswer(
  cur: FinanceStats,
  prev: FinanceStats,
  curPhrase: string,
  prevPhrase: string
): string {
  const noCur = cur.expenseCount === 0 && cur.incomeCount === 0;
  const noPrev = prev.expenseCount === 0 && prev.incomeCount === 0;
  if (noCur && noPrev) {
    return `${curPhrase}和${prevPhrase}都没有记账记录，无法对比。\n\n以上为精确统计，口径与周报/月报一致。`;
  }
  const currencies = [...new Set([...Object.keys(cur.totals), ...Object.keys(prev.totals)])];
  const lines = currencies.map((c) => {
    const a = cur.totals[c] ?? { expense: 0, income: 0 };
    const b = prev.totals[c] ?? { expense: 0, income: 0 };
    const dExp = a.expense - b.expense;
    const expVerdict = dExp > 0 ? `多花 ${formatAmount(dExp, c)}` : dExp < 0 ? `少花 ${formatAmount(-dExp, c)}` : "持平";
    const dInc = a.income - b.income;
    const incVerdict = dInc > 0 ? `多 ${formatAmount(dInc, c)}` : dInc < 0 ? `少 ${formatAmount(-dInc, c)}` : "持平";
    return `- ${c}：支出 ${curPhrase} ${formatAmount(a.expense, c)}，${prevPhrase} ${formatAmount(b.expense, c)}，较${prevPhrase}${expVerdict}；收入 ${curPhrase} ${formatAmount(a.income, c)}，${prevPhrase} ${formatAmount(b.income, c)}，较${prevPhrase}${incVerdict}`;
  });
  let md = `${curPhrase}与${prevPhrase}对比（按币种分别比较，不同币种金额不可直接比较）：\n${lines.join("\n")}\n${curPhrase}共 ${cur.expenseCount} 笔支出、${cur.incomeCount} 笔收入；${prevPhrase}共 ${prev.expenseCount} 笔支出、${prev.incomeCount} 笔收入。`;
  const unknown = cur.unknownAmount + prev.unknownAmount;
  if (unknown > 0) md += `\n（另有 ${unknown} 笔未识别出金额，未计入对比。）`;
  md += `\n\n以上为精确统计，口径与周报/月报一致。`;
  return md;
}

// ---- 计数/枚举类问答（R124 P1-2）----
// 「记了多少条」类计数问题与财务聚合同理：必须走 SQL COUNT 精确计数，绝不能
// 让 LLM 对被 LIMIT 截断的召回窗口猜总数（R123 实测：实为 210 条答成 16）。
// 带主题限定无法精确 SQL 化时 fail-closed 说明，仍给出可精确的总数。

/** 问的是「记了多少条/几条笔记」这类计数（金额类交财务路径优先处理）。 */
const COUNT_Q_RE = /(?:多少|几)\s*[条篇](?:笔记|记录)?|(?:记|写|存|收藏|保存)[了过]?[^？?。]{0,8}(?:多少|几)\s*[条篇个样件]/;

const COUNT_STRIP_RES: RegExp[] = [
  STRIP_RES[0], // 时间短语，与财务聚合同一口径
  /到目前为止|截止到?现在|截至现在|至今|目前|现在|为止|开始记录以来|一共|总共|合计|总计|共计|加起来|到底|大概|大约|多少|几/g,
  /笔记|记录|条|篇|个|样|件|东西|内容|事情|事/g,
  /记|写|存|收藏|保存|发/g,
  /请问|一下|来着|帮我数|数数|统计|我的?|了|过|吗|呢|啊|呀|哦|是|都|在|有|？|\?|，|,|。|、|\s/g,
];

// 分类限定词 → category 列值（R126：分类计数是一条 WHERE category=? 就能精确
// 回答的问题，不应落 fail-closed；R125 Q9/Q10/Q12）。支出/收入类计数已由
// 财务聚合路径处理，不在此列。
const COUNT_CATEGORY_WORDS: [RegExp, string][] = [
  [/待办|代办|todo/i, "todo"],
  [/想法|点子|灵感/, "idea"],
  [/收藏/, "collect"],
  [/资料/, "data"],
];

/** 计数问题的结构化意图：精确路径支持分类/敏感/日均限定（R126）。 */
export interface CountQuery {
  intent: "exact" | "fail_closed";
  /** 分类限定（待办/想法/收藏/资料），WHERE category = ? 精确计数 */
  category: string | null;
  /** 「加密/敏感笔记有几条」：WHERE is_sensitive = 1 精确计数 */
  sensitiveOnly: boolean;
  /** 「平均每天记几条」：总数 ÷ 首条笔记至今天数，纯 SQL 可得 */
  avgPerDay: boolean;
}

const COUNT_QUALIFIER_STRIP_RES: RegExp[] = [
  /待办|代办|todo|想法|点子|灵感|收藏|资料/gi,
  /加密|敏感/g,
  /平均每天|平均|每天/g,
  /类的?|这类|一类/g,
];

/**
 * How /api/ask should answer a note-count question:
 * - exact：无额外限定，或只有时间/分类/敏感/日均这些可 SQL 化的限定 → 精确回答。
 * - fail_closed：计数措辞但剩余主题/内容限定 → 拒绝猜数，给出可精确的总数。
 * - null：不是计数问题。
 */
export function countQueryIntent(question: string): CountQuery | null {
  if (!COUNT_Q_RE.test(question)) return null;
  // 金额/账目类计数（几笔支出、花了多少）由财务聚合路径处理
  if (FINANCE_WORD_RE.test(question)) return null;
  if (FACT_QUERY_RE.test(question)) return null;
  const category = COUNT_CATEGORY_WORDS.find(([re]) => re.test(question))?.[1] ?? null;
  const sensitiveOnly = !category && /加密|敏感/.test(question);
  const avgPerDay = /平均每天|每天平均/.test(question);
  let residual = question;
  for (const re of COUNT_STRIP_RES) residual = residual.replace(re, "");
  for (const re of COUNT_QUALIFIER_STRIP_RES) residual = residual.replace(re, "");
  const intent = residual.length < 2 ? "exact" : "fail_closed";
  return { intent, category: intent === "exact" ? category : null, sensitiveOnly: intent === "exact" && sensitiveOnly, avgPerDay: intent === "exact" && avgPerDay };
}

/** 兼容包装：只关心 exact/fail_closed/null 的调用方（召回重写路由等）。 */
export function countAggIntent(question: string): "exact" | "fail_closed" | null {
  return countQueryIntent(question)?.intent ?? null;
}

// ---- 财务极值（R148 P1-2）----
// 「最贵的一笔支出」是一条 ORDER BY amount SQL 就能精确回答的问题，绝不能
// 交 LLM 对 top-k 召回猜极值（R147 实测：答 1980 吉他，实为 8999 MacBook）。
// 金额比较按币种分组：不同币种的金额不可直接比大小。

export interface FinanceExtremeQuery {
  kind: "max" | "min";
  /** 比较对象：支出或收入（默认支出）。 */
  direction: "expense" | "income";
  /** 排名序号：1=极值（最贵/最便宜），2=第二贵/排名第二……倒数序已归一化
   * 进 kind（倒数第二贵 = kind:min, rank:2）。 */
  rank: number;
  /** 「倒数第N便宜/贵」的形容词（R198，audit-r197 P3-4）：倒序问法有两种
   * 自然语义，答案里附排序口径消歧义。 */
  reversedAdj?: string;
  /** 验证式提问的金额前提（R200，audit-r199 P2-1）：「最贵的一笔支出是 400 元吗」
   * 的「400 元」是待验证的前提而非主题词——按精确查询结果如实答是/否。 */
  premise?: { amount: number; currency: string | null };
}

// 验证式金额前提（R200，audit-r199 P2-1）：「是 N 元吗 / 是不是 N 块」。
// 语气助词或「是不是/是否」二选一必须在场，否则「第 2 大」这类序数里的
// 数字不会被误认成前提。「是否为/是否是/是不是为 N 块钱」这类双动词变体
// 同样是验证式问法（R202，audit-r201 P3-1）。币种词缺省视为与记录同币种比较。
const EXTREME_PREMISE_RE =
  /(是不是|是否|是|为)?[是为]?\s*(\d+(?:\.\d+)?)\s*(元|块钱?|人民币|rmb|cny|美元|美金|usd|日元|jpy|欧元|eur|英镑|gbp|港[币元]|hkd|韩元|krw)?\s*(?:钱)?\s*([吗么嘛吧])?/gi;

const PREMISE_CURRENCY: Record<string, string> = {
  元: "CNY", 块: "CNY", 块钱: "CNY", 人民币: "CNY", rmb: "CNY", cny: "CNY",
  美元: "USD", 美金: "USD", usd: "USD",
  日元: "JPY", jpy: "JPY",
  欧元: "EUR", eur: "EUR",
  英镑: "GBP", gbp: "GBP",
  港币: "HKD", 港元: "HKD", hkd: "HKD",
  韩元: "KRW", krw: "KRW",
};

/** 解析验证式金额前提；非验证式问法返回 null。 */
export function financeExtremePremise(question: string): { amount: number; currency: string | null } | null {
  for (const m of question.matchAll(EXTREME_PREMISE_RE)) {
    const [, lead, num, unit, particle] = m;
    if (!particle && lead !== "是不是" && lead !== "是否") continue;
    const amount = Number(num);
    if (!Number.isFinite(amount)) continue;
    return { amount, currency: unit ? (PREMISE_CURRENCY[unit.toLowerCase()] ?? null) : null };
  }
  return null;
}

// 序数排名问法（R182 P1-2）：「第二贵/排名第二/倒数第二」与极值同属
// ORDER BY amount 的确定性查询（取第 rank 名），绝不交 LLM 猜排序。
// 形容词定基准方向（贵/高/大/多→max，便宜/低/小/少→min，无形容词的
// 「排名第N」默认从大到小）；「倒数」翻转基准方向（倒数第二贵=第二便宜）。
// 「第二次买/第二天」是时间序数不是金额排名：无形容词且无排名词时不收口。
// 阿拉伯数字两侧常被用户加空格（「第 2 大」），允许行内空白。
const ORD_RE = /(倒数)?(排(?:名|行)?)?(倒数)?第[ \t]*([0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(贵|便宜|高|低|大|小|多|少|狠)?/;

/** 解析序数排名措辞；非排名问法返回 null。sortBase 为「按金额/价格…排」
 * 排序指令短语给出的基准方向（R192 P2-1）：此语境下「第三名」这类无形容词
 * 序数也是金额排名，按排序方向收口。 */
function financeOrdinal(question: string, sortBase: "max" | "min" | null = null): { kind: "max" | "min"; rank: number; reversedAdj?: string } | null {
  const m = question.match(ORD_RE);
  if (!m) return null;
  const [, rev1, rankWord, rev2, num, adj] = m;
  const reversed = Boolean(rev1 || rev2);
  // 「第二次买/第二天」是时间序数：无形容词、无排名词、无倒数、无排序指令
  // 短语时不收口
  if (!adj && !rankWord && !reversed && !sortBase) return null;
  const rank = parseNum(num);
  if (!rank || rank < 1 || !Number.isInteger(rank)) return null;
  const base: "max" | "min" = adj ? (/便宜|低|小|少/.test(adj) ? "min" : "max") : (sortBase ?? "max");
  const kind = reversed ? (base === "max" ? "min" : "max") : base;
  // 「倒数第N便宜/贵」有歧义（R198，audit-r197 P3-4）：按「便宜榜倒序」理解，
  // 答案里附口径说明供用户校验
  return { kind, rank, ...(reversed && adj && /便宜|贵/.test(adj) ? { reversedAdj: adj } : {}) };
}

// 排序指令短语（R192 P2-1，audit-r191）：「按价格从高到低排，第三名是什么」
// 无任何 FINANCE_WORD，但金额/价格排序语义已经明确——序数在此语境下收口进
// 确定性路线，不再整条路由落空给「没找到」+ 敏感误导提示。
const PRICE_SORT_RE = /按(?:金额|价格|价钱|数额)(?:从?([高低大小])到[高低大小])?排/;

// 元问题（R176 P1-2）：「最近在想什么/帮我总结」这类对全部笔记的生成型提问，
// 意图判定必须以原始问题为准（R113 原则）——改写器可能把上一轮的财务措辞注入
// recallQuestion，绝不允许改写产物把元问题劫持进确定性财务/统计路由。
export const ASK_META_QUESTION_RE = /在想什么|在想些什么|想了?些?什么|总结一下|帮我总结|概括一下|梳理一下|回顾一下|最近在忙什么|近况/;

// 指代追问（R186 P1）：问题里的代词/指示词（「它/那条/这笔…」）指向前轮实体，
// 原始问题不自足——R113「意图以原始问题为准」的前提（原始问题可独立理解）
// 不成立，此时意图判定与召回一致，都以改写产物为准。「这个月/那个星期」是
// 时间限定不是指代；「其它」不是代词「它」。
export const ASK_PRONOUN_REF_RE =
  /(?<!其)它|他们|她们|这条|那条|这笔|那笔|这个(?!月|周|星期|礼拜)|那个(?!月|周|星期|礼拜)|这次|那次|这件|那件|这本|那本|这台|那台|这部|那部|这家|那家|这只|那只|这张|那张/;

/** 识别财务极值问题（最贵/最大/最小一笔支出、金额最高的收入等）。 */
export function financeExtremeIntent(question: string): FinanceExtremeQuery | null {
  // 「多少钱/花费/费用」不在 FINANCE_WORD_RE 里，但配上极值措辞（最贵/最便宜）
  // 已是明确的财务极值问法（R175 P2-2：「打车里最贵的一次是多少钱」漏判走 LLM）
  // 「最贵/最便宜」本身就是价格比较语义（R178 P1-3：「键盘里最便宜的是哪一把」
  // 无任何财务词，漏判走 LLM 答错 599 vs 458）——价格固有的极值措辞单独成立；
  // 「最高/最低/最大/最小」仍歧义（最高的山），必须配财务词才收口。
  // 「第N贵/第N便宜」与「最贵/最便宜」同为价格固有措辞（R182 P1-2）
  const sortM = question.match(PRICE_SORT_RE);
  const priceInherent = /最贵|最便宜|花得?最[多少]|花钱最[狠多猛]|金额最[大高小低]|数额最[大小]/.test(question) || /(倒数)?第[ \t]*([0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(贵|便宜)/.test(question) || Boolean(sortM);
  if (!priceInherent && !FINANCE_WORD_RE.test(question) && !/买|多少钱|花费|费用/.test(question)) return null;
  const direction: "expense" | "income" = /收入|进账|入账|赚|挣/.test(question) ? "income" : "expense";
  const premise = financeExtremePremise(question);
  const p = premise ? { premise } : {};
  const ord = financeOrdinal(question, sortM ? (sortM[1] && /[低小]/.test(sortM[1]) ? "min" : "max") : null);
  if (ord) return { kind: ord.kind, direction, rank: ord.rank, ...(ord.reversedAdj ? { reversedAdj: ord.reversedAdj } : {}), ...p };
  // 「最大收入/最小支出」这类极值词直接修饰财务名词（无「一笔」）同样是
  // 单笔极值问法（R202：「本月最大收入是 4500 元吗」漏判落 RAG 自相矛盾）
  if (/最贵|最高|最大的?一?[笔项]|最[大高]的?(?:收入|进账|入账|支出|消费|开销|花销|花费)|金额最[大高]|花得?最多|花钱最[狠多猛]|最狠的?一[笔次]|数额最大/.test(question)) return { kind: "max", direction, rank: 1, ...p };
  if (/最便宜|最低|最小的?一?[笔项]|最[小低]的?(?:收入|进账|入账|支出|消费|开销|花销|花费)|金额最[小低]|花得?最少|数额最小/.test(question)) return { kind: "min", direction, rank: 1, ...p };
  return null;
}

// 极值问法的主题限定（R174 P1）：「我买过的键盘里最贵的是哪一把」的「键盘」
// 必须注入 SQL WHERE（与财务子集/主题枚举同一 LIKE 匹配家族），绝不能识别出
// 极值意图后丢掉主题限定答成全局极值（R173 实测 3/3 复现）。剥掉极值措辞/
// 财务词/时间短语/购买动词/量词填充后，残留的干净词即主题限定词。
const EXTREME_STRIP_RES: RegExp[] = [
  STRIP_RES[0], // 时间短语，与财务聚合同一口径
  /最贵|最便宜|金额最[大高小低]|最[高低]|最大的?一?[笔项个]|最小的?一?[笔项个]|花得?最[多少]|花钱最[狠多猛]|最狠的?一[笔次]|数额最[大小]|(?:倒数)?排(?:名|行)?(?:倒数)?第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠)?|倒数第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠)?|第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠|名)/g,
  // 「单笔最贵」的「单笔」是计量口径词、「按金额排」的「按…排」是排序指令词，
  // 都不是主题限定（R190 P1-1：残渣注入 WHERE 让确定性路线自己否证自己）
  /单笔|每笔|逐笔|单[次项]|按(?:金额|价格|价钱|数额)?(?:从?[高低大小]到[高低大小])?排(?:序|名|行|列)?/g,
  /金额|数额/g, // 「金额倒数第二」的「金额」是排名量纲词不是主题限定
  /(?:是)?哪一?[笔项个把只台件本条张部次辆双瓶副架块支款]?|什么|多少钱|多少/g,
  /[一两][笔项次个把只台件本条张部辆双瓶副架块支款]/g,
  /买[过了的]{0,2}|购入|入手|里面?|之中|当中|其中|这些|那些|所有|全部|历史上|有史以来|记录里|笔记里/g,
  STRIP_RES[2], // 财务动词/名词
  STRIP_RES[3], // 语气/填充
];

// 剥词残渣 fail-safe（R190 P1-1，audit-r189 §6.2）：纯由计量/排序/程度功能字
// 组成的残渣（「单笔」「按排」这类）不是名词性主题，视为无主题限定——绝不
// 注入 WHERE 后零命中答「没找到」（真值明明在库里）。
// 「否/为」是「是否为 N 块钱」验证式问法（R202 P3-1）剥掉金额后的系词残渣，
// 不是主题；真主题词（如「华为手机」）因含其他实义字不受影响
const EXTREME_FUNCTIONAL_RESIDUE_RE = /^[单每逐笔项次个把按排序名行列第倒数最高低大小多少贵狠便宜是否为的来源]+$/;

// 金额 token 不是主题词（R200，audit-r199 P2-1）：「最贵的一笔支出是 400 元吗」
// 的「400元」注入 WHERE 会让确定性路线自己否证自己（正文「学费 400」不含
// 「400元」字样 → 零命中 →「没找到」）。小数形态因「.」不在主题词字符集里
// 本就被滤掉，整数与带币种词形态在此统一剥除；孤立纯数字残渣同样不是主题。
const AMOUNT_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:元|块钱?|人民币|美元|美金|日元|欧元|英镑|港[币元]|韩元|rmb|cny|usd|jpy|eur|gbp|hkd|krw)/gi;
const PURE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

/** 从财务极值问法中提取主题限定词（「键盘里最贵的」→「键盘」）；无限定返回 null。 */
export function financeExtremeTopicTerms(question: string): string[] | null {
  if (!financeExtremeIntent(question)) return null;
  let residual = question.replace(AMOUNT_TOKEN_RE, "");
  for (const re of EXTREME_STRIP_RES) residual = residual.replace(re, "");
  residual = residual.replace(/^的+|的+$/g, "");
  const terms = residual
    .split(/和|跟|以及|、|的/)
    .map((s) => s.trim().replace(/[里中]$/, ""))
    .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) && !TOPIC_ENUM_GENERIC_RE.test(s) && !EXTREME_FUNCTIONAL_RESIDUE_RE.test(s) && !PURE_NUMBER_RE.test(s));
  return terms.length > 0 && terms.length <= 3 ? terms : null;
}

/** 台账聚合笔记判定（R180 P2-1）：多行台账笔记的金额是 fixLedgerAmount 锁定的
 * 列合计（R178），不是一笔消费——极值比较把它当单笔会冒充「最便宜的一把」。
 * 复用 parseLedgerTable 同一确定性解析器：内容解析出多行台账且笔记金额等于
 * 该合计时判为聚合笔记（用户手改过金额则金额已非合计，照常参与比较）。 */
export function isLedgerAggregateNote(n: Pick<NoteRow, "content" | "amount">): boolean {
  if (typeof n.amount !== "number" || !Number.isFinite(n.amount)) return false;
  const ledger = parseLedgerTable(n.content);
  return ledger !== null && Math.abs(n.amount - ledger.amount) < 0.005;
}

const FINANCE_DIRECTION_LABELS: Record<"expense" | "income", string> = { expense: "支出", income: "收入" };

/** 财务极值的确定性答案：按币种分组比较，敏感笔记只报金额/时间不露内容。 */
export function buildFinanceExtremeAnswer(
  query: FinanceExtremeQuery,
  rows: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "is_sensitive" | "amount" | "currency">[],
  unknownAmount: number,
  phrase: string | null,
  terms: string[] | null = null,
  ledgerExcluded = 0,
  shortCurrencies: { currency: string; count: number }[] = []
): string {
  const topic = terms && terms.length > 0 ? `「${terms.join("、")}」` : null;
  const scope = `${phrase ?? ""}${topic ? `与${topic}相关的记录里` : phrase ? "" : "全部笔记"}`;
  const label = FINANCE_DIRECTION_LABELS[query.direction];
  const rank = query.rank ?? 1;
  const kindLabel =
    rank === 1
      ? query.kind === "max"
        ? "金额最大"
        : "金额最小"
      : `金额第 ${rank} ${query.kind === "max" ? "大" : "小"}`;
  const ledgerNote = ledgerExcluded > 0 ? `另有 ${ledgerExcluded} 条多行台账笔记的金额为多笔合计，未参与单笔比较` : "";
  const shortNote =
    shortCurrencies.length > 0
      ? `币种 ${shortCurrencies.map((s) => `${s.currency} 已识别金额的单笔${label}仅 ${s.count} 笔`).join("、")}，不存在第 ${rank} 名`
      : "";
  if (rows.length === 0) {
    // 时间口径明示（R202，audit-r201 P3-3）：带时间短语却零命中时，说明范围
    // 按记录时间划定——「本月最大收入」查不到正文写「三月」的当月新笔记时，
    // 用户能看出口径差异而不是以为数据丢了
    const extras = [
      shortNote,
      ledgerNote,
      unknownAmount > 0 ? `另有 ${unknownAmount} 笔${label}未识别出金额` : "",
      phrase ? "时间范围按笔记记录时间划定，不按正文里写的时间" : "",
    ].filter(Boolean);
    if (rank > 1 && shortCurrencies.length > 0) {
      return `${scope}已识别出金额的单笔${label}不足 ${rank} 笔，不存在${kindLabel}的一笔。（${extras.join("；")}。）`;
    }
    return `${scope}没有已识别出金额的单笔${label}记录，无法比较金额大小。${extras.length > 0 ? `（${extras.join("；")}。）` : ""}`;
  }
  const lines = rows.map((n, i) => {
    const amount = formatAmount(n.amount ?? 0, n.currency || "CNY");
    const when = formatShanghai(n.created_at);
    const desc = n.is_sensitive
      ? "（加密的敏感笔记，内容不在问答中展示）"
      : `：${(n.title || n.content).replace(/\s+/g, " ").slice(0, 60)}`;
    const cite = n.is_sensitive ? "" : ` [${i + 1}]`;
    return rows.length === 1
      ? `${topic ? `${scope}，` : ""}你${kindLabel}的一笔${label}是 ${amount}（${when}，北京时间）${cite}${desc}`
      : `- ${n.currency || "CNY"}：${amount}（${when}，北京时间）${cite}${desc}`;
  });
  // 验证式前提（R200，audit-r199 P2-1）：有确定的比较对象才给是/否判定；
  // 多币种无法定位目标币种时不强判，只列事实。
  let verdict = "";
  if (query.premise) {
    const target =
      rows.length === 1 && !query.premise.currency
        ? rows[0]
        : rows.find((r) => (r.currency || "CNY") === (query.premise!.currency ?? "CNY"));
    if (target) {
      const eq = Math.abs((target.amount ?? 0) - query.premise.amount) < 0.005;
      verdict = eq ? "是的。" : "不是。";
    }
  }
  let md = rows.length === 1 ? verdict + lines[0] : `${verdict}${scope}按币种分别比较（不同币种金额不可直接比较），${kindLabel}的${label}：\n${lines.join("\n")}`;
  md += `\n\n以上为数据库精确查询结果（${topic ? `按关键词${topic}匹配标题/正文/标签，` : ""}按已识别金额${rank === 1 ? "比较" : "排序取第 " + rank + " 名"}，不含已删除笔记${phrase ? "；时间范围按笔记记录时间划定，不按正文里写的时间" : ""}${unknownAmount > 0 ? `；另有 ${unknownAmount} 笔未识别出金额，未参与比较` : ""}${ledgerNote ? `；${ledgerNote}` : ""}${shortNote ? `；${shortNote}` : ""}）。`;
  if (query.reversedAdj) {
    md += `\n（排序口径：“倒数第 ${rank} ${query.reversedAdj}”按“${query.reversedAdj}榜倒序”理解，即金额第 ${rank} ${query.kind === "max" ? "大" : "小"}；如你想问金额第 ${rank} ${query.kind === "max" ? "小" : "大"}，请直接问“第 ${rank} ${query.kind === "max" ? "便宜" : "贵"}”。）`;
  }
  return md;
}

/** 台账行级极值（R198，audit-r197 §3 第 5 点）：主题词命中的只有台账聚合
 * 笔记、无单笔可比时（「餐饮台账里最贵的一项」），用台账明细行金额做
 * 确定性排序作答，不再答「无法比较」。标题命中（问的是台账本身）取全表
 * 明细行，仅正文行级命中取命中行；合计行与负数（退款）行不参与大小
 * 排序，如实披露；敏感台账正文加密，不参与行级作答。 */
export function buildLedgerRowExtremeAnswer(
  query: FinanceExtremeQuery,
  ledgers: Pick<NoteRow, "id" | "title" | "content" | "currency" | "is_sensitive">[],
  terms: string[],
  phrase: string | null
): { answer: string; noteIds: string[] } | null {
  const rows: { label: string; amount: number; currency: string; noteId: string }[] = [];
  for (const n of ledgers) {
    if (n.is_sensitive) continue;
    const titleHit = terms.some((t) => (n.title ?? "").includes(t));
    for (const h of ledgerRowsMatching(n.content, titleHit ? null : terms)) {
      rows.push({ ...h, currency: n.currency || "CNY", noteId: n.id });
    }
  }
  const negatives = rows.filter((r) => r.amount <= 0).length;
  const positive = rows.filter((r) => r.amount > 0);
  if (positive.length === 0) return null;
  const byCurrency = new Map<string, typeof positive>();
  for (const r of positive) {
    const list = byCurrency.get(r.currency) ?? [];
    list.push(r);
    byCurrency.set(r.currency, list);
  }
  const rank = query.rank ?? 1;
  const picks: typeof positive = [];
  const short: { currency: string; count: number }[] = [];
  for (const [cur, list] of byCurrency) {
    list.sort((a, b) => (query.kind === "max" ? b.amount - a.amount : a.amount - b.amount));
    if (list.length >= rank) picks.push(list[rank - 1]);
    else short.push({ currency: cur, count: list.length });
  }
  if (picks.length === 0) return null;
  const noteIds = [...new Set(picks.map((p) => p.noteId))];
  const cite = (id: string) => ` [${noteIds.indexOf(id) + 1}]`;
  const topic = `「${terms.join("、")}」`;
  const scope = `${phrase ?? ""}${topic}相关的台账里`;
  const kindLabel =
    rank === 1 ? `金额最${query.kind === "max" ? "大" : "小"}` : `金额第 ${rank} ${query.kind === "max" ? "大" : "小"}`;
  const lines = picks.map(
    (p) => `- ${p.currency}：${p.label} ${formatAmount(p.amount, p.currency)}${cite(p.noteId)}`
  );
  let md =
    picks.length === 1
      ? `${scope}，${kindLabel}的一项明细是「${picks[0].label}」 ${formatAmount(picks[0].amount, picks[0].currency)}${cite(picks[0].noteId)}`
      : `${scope}按币种分别比较（不同币种金额不可直接比较），${kindLabel}的明细行：\n${lines.join("\n")}`;
  const shortNote =
    short.length > 0 ? `币种 ${short.map((s) => `${s.currency} 明细行仅 ${s.count} 行`).join("、")}，不存在第 ${rank} 名` : "";
  md += `\n\n以上为数据库精确查询结果（台账行级明细口径：按命中${topic}的台账明细行金额${rank === 1 ? "比较" : `排序取第 ${rank} 名`}，合计行不参与${negatives > 0 ? `；另有 ${negatives} 行负数（退款）明细未参与大小比较` : ""}${phrase ? "；时间范围按笔记记录时间划定，不按正文里写的时间" : ""}${shortNote ? `；${shortNote}` : ""}）。`;
  if (query.reversedAdj) {
    md += `\n（排序口径：“倒数第 ${rank} ${query.reversedAdj}”按“${query.reversedAdj}榜倒序”理解，即金额第 ${rank} ${query.kind === "max" ? "大" : "小"}；如你想问金额第 ${rank} ${query.kind === "max" ? "小" : "大"}，请直接问“第 ${rank} ${query.kind === "max" ? "便宜" : "贵"}”。）`;
  }
  return { answer: md, noteIds };
}

// ---- 主题关键词计数（R148 P1-2）----
// 「记录过几次房租」这类按主题计次的问题：主题词可从问法中干净提取时，
// 走 SQL LIKE 精确计数（与主题枚举同一关键词匹配家族），答案如实标注
// 「按关键词匹配」口径；提取不出时仍由计数 fail-closed 兜底。

const TOPIC_COUNT_RES: RegExp[] = [
  // 「记录过几次房租」「提到过多少次咖啡」；交/付/买/花等行为动词同样按主题计次
  /(?:记录?|写|提到?|说|交|付|买|花|去|吃|喝)[过了]{1,2}(?:多少|几)次([\u4e00-\u9fa5A-Za-z0-9]{1,12})/,
  // 「房租记录过几次」「咖啡一共提过多少次」「房租交过几次」
  /([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)(?:我?一共|我?总共)?(?:被)?(?:记录?|写|提到?|说|交|付|买|花|去|吃|喝)[过了]{1,2}(?:多少|几)次/,
  // 「房租出现过几次」
  /([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)出现[过了]{1,2}(?:多少|几)次/,
  // 「我一共记了几条跟健身有关的」「跟健身相关的笔记有多少条」——「跟X有关」
  // 式计条与计次同族，走同一 LIKE 精确计数口径（R168 设计建议 2：q12 类
  // 问法此前先答"没找到"再补统计，路由不稳定）
  /(?:多少|几)\s*条(?:是)?(?:跟|和|与|关于)([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)(?:有关|相关)/,
  /(?:跟|和|与|关于)([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)(?:有关|相关)的?(?:笔记|记录|内容)?[^？?。]{0,8}?(?:多少|几)\s*条/,
];

/** 识别「主题 + 计次」问题，返回用于 LIKE 精确计数的主题词；非此类返回 null。 */
export function topicCountIntent(question: string): string | null {
  if (FACT_QUERY_RE.test(question)) return null;
  const q = question.replace(/[？?。！!\s]+$/g, "").replace(STRIP_RES[0], "");
  for (const re of TOPIC_COUNT_RES) {
    const topic = q.match(re)?.[1]?.replace(/^(?:关于|有关|我的?|把)/, "").replace(/^的+|的+$/g, "").trim();
    if (topic && topic.length >= 2 && !TOPIC_ENUM_GENERIC_RE.test(topic)) return topic;
  }
  return null;
}

/** 主题关键词计数的精确答案（如实标注按关键词匹配口径）。 */
export function buildTopicCountAnswer(topic: string, cnt: number, sensitiveCnt: number, phrase: string | null): string {
  const scope = phrase ?? "到目前为止";
  if (cnt === 0) {
    return `按关键词「${topic}」精确匹配（标题/正文/标签），${scope}没有匹配到相关笔记。\n\n以上为数据库精确统计（关键词匹配口径，不含已删除笔记）。如果你的记录用了别的说法，换个关键词再问试试。`;
  }
  let md = `按关键词「${topic}」精确匹配（标题/正文/标签），${scope}共记录了 ${cnt} 条相关笔记`;
  if (sensitiveCnt > 0) md += `（含 ${sensitiveCnt} 条加密的敏感笔记，内容不在问答中展示）`;
  md += "。\n\n以上为数据库精确统计（关键词匹配口径，不含已删除笔记）。";
  return md;
}

// ---- 财务主题子集合计（R148 P1-2）----
// 「咖啡一共花了多少」这类带主题限定的合计：主题词可干净提取时，走 SQL
// LIKE 圈定子集后按 financeStats 同一口径精确合计（R147：此前一律 fail-closed，
// 诚实但找回失败）；提取不出干净主题词时仍 fail-closed，绝不交 LLM 心算。

// 财务子集问法的合计措辞：强合计词，或「花了多少（钱）」这类弱合计问法
const SUBSET_AGG_RE = /一共|总共|合计|总计|共计|加起来|总额|花了?多少|多少钱/;

/** 从财务合计问法中提取主题限定词；非「主题 + 合计」问法返回 null。 */
export function financeTopicTerms(question: string): string[] | null {
  if (isFinanceAggQuestion(question)) return null; // 无限定 → 全局精确合计
  if (FACT_QUERY_RE.test(question)) return null;
  // 「包括/算上…吗」是口径澄清问句而非子集合计：交澄清路由或普通召回，
  // 绝不把残留的追问措辞抽成垃圾关键词（R151 P2-2）
  if (/包括|包含|算上|算进|在内/.test(question)) return null;
  if (!FINANCE_WORD_RE.test(question) || !SUBSET_AGG_RE.test(question)) return null;
  return subsetTopicExtract(question);
}

// 量词短语尾巴不是主题的一部分（R200，audit-r199 P2-1 同根因家族）：
// 「车厘子买几斤」「咖啡机除垢剂一次」整串注入 LIKE 必零命中，
// 剥掉尾部「（买/吃…）+ 数量 + 单位」后留下名词主题。
const QUANTIFIER_TAIL_RE =
  /(?:买|吃|喝|用|囤|购|拿|来)?[了过的]{0,2}(?:每|一|两|几|多少|\d+)(?:多)?(?:斤|克|千克|公斤|磅|升|毫升|次|回|趟|顿|份|包|袋|盒|瓶|箱|杯|桶|支|卷|片|粒|颗|双|对|套|罐|听)(?:用|吃|喝|买|囤|服)?$/;

/** 主题词剥离流水线（financeTopicTerms / financeShortTopicTerms 共用）。 */
function subsetTopicExtract(question: string): string[] | null {
  // 金额 token 不是主题词（R200，audit-r199 P2-1）：改写产物/追问里混入的
  // 「399元」这类金额残片不得注入 LIKE
  let residual = question.replace(AMOUNT_TOKEN_RE, "");
  for (const re of STRIP_RES) residual = residual.replace(re, "");
  // 时间限定词不属于主题（「2026年7月咖啡」→「咖啡」）：时间过滤由
  // parseTimeRange 负责，残留的年月日 token 一律剥掉
  residual = residual.replace(/\d{2,4}\s*年|\d{1,2}\s*月(?:份)?|\d{1,2}\s*[日号]|上+个?[月周]|这个?[月周]|本[月周]|最近|今年|去年|前年/g, "");
  // 剥掉开头的购买/消费动词（「买咖啡」→「咖啡」），但不能把「吃喝」这类
  // 本身就是主题的词剥空
  const stripped = residual.replace(/^[买在喝吃点逛去为给用出]{1,2}/, "").replace(/^(?:你|您|咱)+/, "");
  if (stripped.length >= 2) residual = stripped;
  const terms = residual
    .split(/和|跟|以及|、/)
    .map((s) => s.trim().replace(QUANTIFIER_TAIL_RE, ""))
    .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) && !TOPIC_ENUM_GENERIC_RE.test(s) && !PURE_NUMBER_RE.test(s));
  return terms.length > 0 && terms.length <= 3 ? terms : null;
}

// ---- 短问法数据门控路由（R198，audit-r197 §3）----
// 「X多少钱？」无任何 FINANCE_WORD，不能靠放宽词典门槛收口（会误伤
// 「身高多少/气温多少」类非财务问题）；改用数据门控：主题词能否命中
// 财务笔记的标题/正文（含台账行名目）才是精准信号——命中才走确定性
// 子集答案，零命中/仅标签命中回落普通召回（绝不落全账合计兑底）。
// 门控判定在 /api/ask 路由层。

/** 短问法（「X多少钱」无财务词）的主题词提取；非此类问法返回 null。
 * 带财务词的问法交既有 financeTopicTerms 路由，两者互斥。 */
export function financeShortTopicTerms(question: string): string[] | null {
  if (FINANCE_WORD_RE.test(question)) return null;
  if (!/多少钱|多少/.test(question)) return null;
  if (FACT_QUERY_RE.test(question)) return null;
  if (/包括|包含|算上|算进|在内/.test(question)) return null;
  // 代词指代（「它多少钱」）问的是前轮实体，主题词不自足：交普通召回
  if (ASK_PRONOUN_REF_RE.test(question)) return null;
  return subsetTopicExtract(question);
}

// 财务子集关键词降级重试（R192 P2-2，audit-r191）：整串 LIKE 零命中不再一次
// miss 即 fail-closed——先剥掉台账/账本等容器残片与「什么牌子」类疑问残片，
// 剥不动的长词再按「的」拆开，产出一组降级关键词重试一次。
const SUBSET_TERM_LEAD_RE = /^(?:台账|账本|流水|账单|明细|记账|记录|笔记)(?:[里中上]的?|的)/;
const SUBSET_TERM_TAIL_RE = /(?:是|的)?(?:什么|啥|哪个|哪家)?(?:牌子|品牌|型号|颜色|款式|口味|尺寸)$|(?:是)?(?:什么|啥)$|买的$/;

/** 生成财务子集关键词的降级重试词集；无可降级时返回 null。 */
export function degradeFinanceSubsetTerms(terms: string[]): string[] | null {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && t.length <= 8 && !TOPIC_ENUM_GENERIC_RE.test(t) && !out.includes(t)) out.push(t);
  };
  for (const t of terms) {
    const stripped = t.replace(SUBSET_TERM_LEAD_RE, "").replace(SUBSET_TERM_TAIL_RE, "");
    if (stripped !== t && stripped.length >= 2) {
      push(stripped);
    } else if (t.length >= 5 && t.includes("的")) {
      for (const piece of t.split("的")) push(piece);
    } else {
      push(t);
    }
  }
  if (out.length === 0 || out.length > 3) return null;
  if (out.length === terms.length && out.every((t, i) => t === terms[i])) return null;
  return out;
}

/** 命中层级：标题/正文直接命中，还是仅靠分拣标签命中（R151 P2-1）。
 * 敏感笔记正文加密、无法核验，按原口径视作直接命中计入合计。 */
export function subsetDirectHit(
  note: Pick<NoteRow, "title" | "content" | "is_sensitive">,
  terms: string[]
): boolean {
  if (note.is_sensitive) return true;
  return terms.some((t) => (note.title ?? "").includes(t) || note.content.includes(t));
}

/** 财务主题子集的精确合计答案：逐笔明细 + 按币种合计，敏感笔记计入合计但不展示内容。
 * 仅标签命中的笔记单列不计入合计（R151 P2-1：分拣标签粒度偏宽——如燃气费被
 * 打上「水电费」标签——会把无关记账算进子集合计）；标题/正文零命中时才退回
 * 标签口径（标签可能是唯一信号，否则正常命中会退化成零结果）。 */
export function buildFinanceSubsetAnswer(
  terms: string[],
  rows: Pick<NoteRow, "id" | "title" | "content" | "tags" | "created_at" | "category" | "is_sensitive" | "amount" | "currency">[],
  phrase: string | null
): string {
  const scope = phrase ?? "到目前为止";
  const kw = terms.join("、");
  const financeAll = rows.filter((n) => n.category === "expense" || n.category === "income");
  const direct = financeAll.filter((n) => subsetDirectHit(n, terms));
  const tagOnly = financeAll.filter((n) => !subsetDirectHit(n, terms));
  const tagFallback = direct.length === 0;
  const finance = tagFallback ? financeAll : direct;
  // 台账行级明细（R196 P2-1）：关键词命中的是台账里某一行名目（标题不含
  // 该词、正文明细行含）时，该台账按命中行的行级金额计入，不拿整表合计
  // 答行级问题；标题命中（问的是台账本身）仍用整表合计。
  const rowHits = new Map<string, { label: string; amount: number }[]>();
  for (const n of finance) {
    if (n.is_sensitive || !isLedgerAggregateNote(n)) continue;
    if (terms.some((t) => (n.title ?? "").includes(t))) continue;
    const hits = ledgerRowsMatching(n.content, terms);
    if (hits.length > 0) rowHits.set(n.id, hits);
  }
  const effAmount = (n: (typeof rows)[number]): number | null => {
    const hits = rowHits.get(n.id);
    if (hits) return Math.round(hits.reduce((s, r) => s + r.amount, 0) * 100) / 100;
    return typeof n.amount === "number" && Number.isFinite(n.amount) ? n.amount : null;
  };
  const totals: Record<string, { expense: number; income: number }> = {};
  let expenseCount = 0;
  let incomeCount = 0;
  let unknown = 0;
  for (const n of finance) {
    const amt = effAmount(n);
    if (amt === null) {
      unknown++;
      continue;
    }
    const cur = n.currency || "CNY";
    totals[cur] ??= { expense: 0, income: 0 };
    if (n.category === "expense") {
      totals[cur].expense += amt;
      expenseCount++;
    } else {
      totals[cur].income += amt;
      incomeCount++;
    }
  }
  const totalLines = Object.entries(totals).map(([cur, t]) => {
    const parts: string[] = [];
    if (t.expense > 0 || expenseCount > 0) parts.push(`支出 ${formatAmount(t.expense, cur)}`);
    if (t.income > 0 || incomeCount > 0) parts.push(`收入 ${formatAmount(t.income, cur)}`);
    return `- ${cur}：${parts.join("，")}`;
  });
  const visible = finance.filter((n) => !n.is_sensitive).slice(0, 10);
  const itemLines = visible.map((n, i) => {
    const date = formatShanghai(n.created_at).slice(0, 10);
    const hits = rowHits.get(n.id);
    if (hits) {
      const cur = n.currency || "CNY";
      const rowsTxt = hits.map((r) => `${r.label} ${formatAmount(r.amount, cur)}`).join("、");
      const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
      return `- ${text} → ${rowsTxt}（台账行级明细，${date}）[${i + 1}]`;
    }
    const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
    const ledger = isLedgerAggregateNote(n) ? "，台账多笔合计" : "";
    const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
    return `- ${text}（${amount}${ledger}，${date}）[${i + 1}]`;
  });
  const sensitiveCnt = finance.filter((n) => n.is_sensitive).length;
  const matchScope = tagFallback ? "仅标签命中，标题/正文无直接命中" : "标题/正文";
  let md = `按关键词「${kw}」精确匹配（${matchScope}），${scope}共 ${expenseCount} 笔支出${incomeCount > 0 ? `、${incomeCount} 笔收入` : ""}：\n${totalLines.join("\n")}`;
  if (itemLines.length > 0) md += `\n\n逐笔明细${finance.length > visible.length ? `（共 ${finance.length} 笔，仅展示前 ${visible.length} 笔）` : ""}：\n${itemLines.join("\n")}`;
  if (sensitiveCnt > 0) md += `\n（含 ${sensitiveCnt} 笔加密的敏感记录，金额已计入合计，内容不在问答中展示。）`;
  if (unknown > 0) md += `\n（另有 ${unknown} 笔未识别出金额，未计入合计。）`;
  if (rowHits.size > 0) md += `\n（台账笔记按命中「${kw}」的明细行行级计入，不计整表合计。）`;
  if (!tagFallback && tagOnly.length > 0) {
    const tagItems = tagOnly
      .filter((n) => !n.is_sensitive)
      .slice(0, 5)
      .map((n) => {
        const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
        const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
        return `${text}（${amount}）`;
      });
    md += `\n（另有 ${tagOnly.length} 笔仅标签命中「${kw}」、标题/正文不含该词的记账未计入合计${tagItems.length > 0 ? `：${tagItems.join("、")}` : ""}；如需把它们算进去，可按标签在时间流筛选后自行确认。）`;
  }
  md += `\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记${phrase ? "；时间范围按笔记记录时间划定，不按正文里写的时间" : ""}）。如果你的记录用了别的说法，换个关键词再问试试。`;
  return md;
}

// ---- 时间窗财务列举（R170 P1-1）----
// 「最近一周我花了哪些钱」这类时间窗+财务列举问题必须与合计/比较同一架构：
// 按 category 走 SQL 精确列举（待办/未发生金额绝不计入），绝不落 top-k 召回
// （R169 实测 12/12 全败：候选层漏掉窗内支出，关图谱还把「待办交房租」
// 幻觉成已发生支出）。窗内无记录时 fail-closed，绝不引用窗外/待办笔记。

export type FinanceListDirection = "expense" | "income" | "both";

const FINANCE_LIST_CUES: [RegExp, FinanceListDirection][] = [
  // 收入/收支线索先判（「赚了哪些钱」不能被支出侧的裸「哪些钱」抢先）
  [/(?:收入|进账|入账)(?:记录|明细|情况)?(?:都)?有哪些|有(?:过)?(?:哪些|些什么|什么)(?:收入|进账|入账)|(?:收入|进账)明细|[赚挣](?:了|到|过)?(?:哪些|些什么|什么)钱|记[了过]?(?:哪些|些什么|什么)(?:收入|进账|入账)/, "income"],
  [/记[了过]?(?:哪些|些什么|什么)账|账单(?:明细)?(?:都)?有哪些|收支明细/, "both"],
  // 「花了哪些钱/花了些什么钱」「哪些钱」「钱都花在哪了」
  [/花了?(?:哪些|些什么|什么)钱|哪些钱|钱(?:都)?(?:花|用)(?:在|到)了?(?:哪|什么)/, "expense"],
  // 「有哪些支出/开销」「支出有哪些」「消费明细」「列一下开销」
  [/(?:支出|开支|开销|花销|消费)(?:记录|明细|情况)?(?:都)?有哪些|有(?:过)?(?:哪些|些什么|什么)(?:支出|开支|开销|花销|消费)|(?:支出|开支|开销|花销|消费)明细|列(?:一下|出|举)?[^？?。]{0,6}(?:支出|开支|开销|花销|消费)/, "expense"],
];

/** 识别财务列举问题（「花了哪些钱」）；带主题限定（「买了哪些书」）返回 null。 */
export function financeListIntent(question: string): FinanceListDirection | null {
  let direction: FinanceListDirection | null = null;
  for (const [re, dir] of FINANCE_LIST_CUES) {
    if (re.test(question)) {
      direction = dir;
      break;
    }
  }
  if (!direction) return null;
  // 残留主题词（「买了哪些书花了哪些钱」）说明不是纯财务列举：留给主题
  // 子集/普通召回，与 isFinanceAggQuestion 同一剥离口径
  let residual = question;
  for (const re of STRIP_RES) residual = residual.replace(re, "");
  residual = residual.replace(/最近|近来|这段时间|一段时间|到目前为止|至今|哪些|些什么|什么|明细|记录|清单|情况|列出|列举|列一下|列|买|花在|花到|用在|用到|地方|各|分别|哪里|哪儿|哪|笔|记|账|的/g, "");
  return residual.length < 2 ? direction : null;
}

const FINANCE_LIST_LABELS: Record<FinanceListDirection, string> = {
  expense: "支出",
  income: "收入",
  both: "收支",
};

/** 财务列举的确定性答案：逐笔明细 + 按币种合计；窗内无记录 fail-closed。 */
export function buildFinanceListAnswer(
  direction: FinanceListDirection,
  rows: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "category" | "is_sensitive" | "amount" | "currency">[],
  phrase: string | null
): string {
  const scope = phrase ?? "到目前为止";
  const label = FINANCE_LIST_LABELS[direction];
  const caliber = `以上为按记账笔记的数据库精确列举（口径与周报/月报一致，不含已删除笔记；待办等尚未发生的计划不计入${phrase ? "；时间范围按笔记记录时间划定，不按正文里写的时间" : ""}）。`;
  if (rows.length === 0) {
    return `${scope}没有找到${label}记录。\n\n按记账笔记（分类为${direction === "both" ? "支出/收入" : label}）的数据库精确查询，${scope}确实没有这类记录；待办等尚未发生的计划不计入，为避免误答我不引用时间范围之外的笔记。如果这段时间的花费还没记账，补记后再问试试。`;
  }
  const totals: Record<string, { expense: number; income: number }> = {};
  let expenseCount = 0;
  let incomeCount = 0;
  let unknown = 0;
  for (const n of rows) {
    if (n.category === "expense") expenseCount++;
    else if (n.category === "income") incomeCount++;
    if (typeof n.amount !== "number" || !Number.isFinite(n.amount)) {
      unknown++;
      continue;
    }
    const cur = n.currency || "CNY";
    totals[cur] ??= { expense: 0, income: 0 };
    if (n.category === "expense") totals[cur].expense += n.amount;
    else if (n.category === "income") totals[cur].income += n.amount;
  }
  const countParts: string[] = [];
  if (expenseCount > 0) countParts.push(`${expenseCount} 笔支出`);
  if (incomeCount > 0) countParts.push(`${incomeCount} 笔收入`);
  const totalLines = Object.entries(totals).map(([cur, t]) => {
    const parts: string[] = [];
    if (t.expense > 0) parts.push(`支出 ${formatAmount(t.expense, cur)}`);
    if (t.income > 0) parts.push(`收入 ${formatAmount(t.income, cur)}`);
    return `- ${cur}：${parts.join("，")}`;
  });
  const visible = rows.filter((n) => !n.is_sensitive).slice(0, 20);
  const itemLines = visible.map((n, i) => {
    const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
    const dir = direction === "both" ? (n.category === "income" ? "收入·" : "支出·") : "";
    const ledger = isLedgerAggregateNote(n) ? "，台账多笔合计" : "";
    const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
    return `- ${text}（${dir}${amount}${ledger}，${formatShanghai(n.created_at).slice(0, 10)}）[${i + 1}]`;
  });
  const sensitiveCnt = rows.filter((n) => n.is_sensitive).length;
  let md = `${scope}你共记了 ${countParts.join("、")}`;
  if (totalLines.length > 0) md += `：\n${totalLines.join("\n")}`;
  if (itemLines.length > 0) md += `\n\n逐笔明细${rows.length > visible.length ? `（共 ${rows.length} 笔，仅展示前 ${visible.length} 笔）` : ""}：\n${itemLines.join("\n")}`;
  if (sensitiveCnt > 0) md += `\n（含 ${sensitiveCnt} 笔加密的敏感记录，金额已计入合计，内容不在问答中展示。）`;
  if (unknown > 0) md += `\n（另有 ${unknown} 笔未识别出金额，未计入合计。）`;
  md += `\n\n${caliber}`;
  return md;
}

// ---- 极值/排序类统计（R126 P1-3）----
// 「最早一条笔记是什么时候记的」类问题是一条 min/max/order-by SQL 就能精确
// 回答的，绝不能交给 LLM 对 top-k 召回猜答（R125 Q3 非确定性错答）。

export type ExtremeKind = "earliest" | "latest" | "longest";

/** 识别极值/排序类笔记统计问题（最早/最新/最后/最长一条笔记）。 */
export function extremeQueryIntent(question: string): ExtremeKind | null {
  if (FINANCE_WORD_RE.test(question)) return null;
  // 必须是在问笔记本身（而非笔记内容里的某个事实，如「最早的航班是几点」）
  if (!/笔记|记录|[记写]的|[记写]了|一条/.test(question)) return null;
  if (/最早|最先|第一条|头一条|最开始|最初/.test(question)) return "earliest";
  if (/最晚|最后一条|最新的?一?条|最近的?一条|最新的笔记/.test(question)) return "latest";
  if (/最长的?/.test(question)) return "longest";
  return null;
}

/** UTC "YYYY-MM-DD HH:MM:SS" → 上海时区可读时间。 */
function formatShanghai(utcSql: string): string {
  const d = new Date(`${utcSql.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return utcSql;
  const sh = new Date(d.getTime() + SH_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${sh.getUTCFullYear()}-${p(sh.getUTCMonth() + 1)}-${p(sh.getUTCDate())} ${p(sh.getUTCHours())}:${p(sh.getUTCMinutes())}`;
}

const EXTREME_LABELS: Record<ExtremeKind, string> = { earliest: "最早", latest: "最新", longest: "最长" };

/** 极值查询的确定性答案（敏感笔记只报时间不露内容）。 */
export function buildExtremeAnswer(
  kind: ExtremeKind,
  note: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "is_sensitive"> | null
): string {
  if (!note) return "你还没有记录任何笔记。";
  const when = formatShanghai(note.created_at);
  const label = EXTREME_LABELS[kind];
  const preview = note.is_sensitive
    ? "（加密的敏感笔记，内容不在问答中展示）"
    : `：${(note.title || note.content).replace(/\s+/g, " ").slice(0, 60)}`;
  const cite = note.is_sensitive ? "" : " [1]";
  return `你${label}的一条笔记记于 ${when}（北京时间）${cite}${preview}\n\n以上为数据库精确查询结果（不含已删除笔记）。`;
}

/** 分类/敏感限定计数的精确答案。 */
export function buildScopedCountAnswer(cnt: number, scopeLabel: string, phrase: string | null): string {
  const scope = phrase ?? "到目前为止";
  if (cnt === 0) return `${scope}你没有${scopeLabel}。\n\n以上为数据库精确统计（不含已删除笔记）。`;
  return `${scope}你共有 ${cnt} 条${scopeLabel}。\n\n以上为数据库精确统计（不含已删除笔记）。`;
}

/** 「平均每天记几条」的精确答案：总数 ÷ 首条笔记至今天数。 */
export function buildAvgPerDayAnswer(total: number, firstCreatedAt: string | null, now: Date = new Date()): string {
  if (total === 0 || !firstCreatedAt) return "你还没有记录任何笔记。";
  const first = new Date(`${firstCreatedAt.replace(" ", "T")}Z`);
  const days = Math.max(1, Math.ceil((now.getTime() - first.getTime()) / 86_400_000));
  const avg = total / days;
  return `从首条笔记（${formatShanghai(firstCreatedAt)}，北京时间）至今共 ${days} 天，记了 ${total} 条笔记，平均每天约 ${avg.toFixed(2)} 条。\n\n以上为数据库精确统计（不含已删除笔记）。`;
}

export const COUNT_SCOPE_LABELS: Record<string, string> = {
  todo: "待办笔记",
  idea: "想法笔记",
  collect: "收藏笔记",
  data: "资料笔记",
};

// 枚举主题词命中分类名（「列出我所有的待办」）时，LIKE '%待办%' 会漏掉
// 正文里没写这两个字的待办笔记；这类问题改按 category 精确筛选全集。
// 只收录与分类一一对应的确切名词，避免把真在找关键词的问题误改口径。
export const ENUM_TOPIC_CATEGORIES: Record<string, string> = {
  待办: "todo",
  待办事项: "todo",
  想法: "idea",
  点子: "idea",
  收藏: "collect",
  资料: "data",
};

/** 「这段时间都记了什么/记了哪些」——时间窗枚举，走 SQL 全量列举而非 top-k 召回。 */
export function enumListIntent(question: string): boolean {
  return /都记[了过]?(?:些|哪些)?什么|记[了过](?:些什么|哪些)|都写[了过]?(?:些|哪些)?什么|都有哪些笔记|记录[了过](?:些什么|哪些|什么)/.test(question);
}

// ---- 主题枚举问答（R130 P1-1/P1-2）----
// 「我看过什么书/存过哪些菜谱」这类枚举+主题词问题：宽泛主题词的语义 top-k
// 在小语料下会被高频主题压过（R129 R8：问「书」召回全是健身笔记），必须先走
// 关键词/标签 LIKE 全量筛选（与财务/计数/极值同一精确查询家族），语义召回只
// 在关键词零命中时兜底。序数追问（「第二本讲什么」）依赖首轮枚举成功 + 既有
// 历史改写解析，不为序数单独增加状态实体。

const TOPIC_ENUM_RES: RegExp[] = [
  // 「存过哪些菜谱」「看过什么书」——经历/收纳动词 + 些/哪些/什么 + 主题名词收尾
  /[看读买去吃喝听学玩逛用聊提存记写收藏保]{1,2}[过了]{1,2}(?:些|哪些|什么|啥)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)(?:的?(?:笔记|记录|内容|想法|点子))?(?:来着|呢|吗|么)?$/,
  // 「记过哪些关于 AI 创业的想法」——枚举措辞 + 关于/有关 + 主题词
  /[过了]?(?:些|哪些|什么|啥)(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容|想法|点子|事)?$/,
  // 「关于健身的笔记有哪些」「有哪些关于健身的记录」
  /(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容)?(?:都)?有哪些/,
  /有哪些(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容)/,
];

// 泛指词不构成主题限定：落回时间窗枚举或普通召回。「什/啥/么/哪些」这类
// 疑问代词碎片（R150 P1-1：「都记了些什么」被捕出单字「什」）同属泛指。
const TOPIC_ENUM_GENERIC_RE = /^(?:东西|事情|事儿?|内容|笔记|记录|信息|什么|什|啥|么|哪些?|的)$/;

/** 识别「枚举+主题词」问题，返回用于 LIKE 全量筛选的主题词；非此类问题返回 null。 */
export function topicEnumIntent(question: string): string | null {
  if (FINANCE_WORD_RE.test(question)) return null;
  if (extremeQueryIntent(question) || countQueryIntent(question)) return null;
  const q = question.replace(/[？?。！!\s]+$/g, "").replace(STRIP_RES[0], "");
  for (const re of TOPIC_ENUM_RES) {
    const topic = q
      .match(re)?.[1]
      ?.replace(/^(?:关于|有关)/, "")
      .replace(/^(?:什么|哪些|啥|些)+/, "")
      .replace(/^的+|的+$/g, "")
      .trim();
    if (topic && !TOPIC_ENUM_GENERIC_RE.test(topic)) return topic;
  }
  return null;
}

// ---- 元属性检索线索（R134 D-3，P2-1 根因）----
// 「语音里我让自己提醒什么事」这类按输入形态找回的问法：「语音」二字
// 通常不在转写正文里，语义检索也不把 raw_type 当线索。规则识别形态词后，
// 召回阶段把 raw_type 匹配的笔记并入候选（只增补、不排除，答案仍由 LLM
// 依据内容给出），不动召回架构。

export type MediaType = "voice" | "image" | "file";

const MEDIA_TYPE_CUES: [RegExp, MediaType][] = [
  [/语音|录音|口述/, "voice"],
  [/图片|照片|截图|拍的/, "image"],
  [/文件|文档|附件/, "file"],
];

/** 问题里的输入形态词（语音/图片/文件）→ raw_type；无形态词返回 null。 */
export function mediaTypeIntent(question: string): MediaType | null {
  for (const [re, t] of MEDIA_TYPE_CUES) if (re.test(question)) return t;
  return null;
}

// ---- 统一意图分类（R132 P1，落实 R131 D-1）----
// 模型为主、规则兜底：既有正则家族保留为高精度第一道（命中即走精确路由，
// 行为与历史轮完全一致）；正则全部未命中时才调用 LLM 意图分类补召回
// （R131 实测 7/15 同义问法漏路由，全部是措辞变体，不再逐条堆正则）。
// LLM 输出经严格校验（意图枚举 + 主题词须出现在原问题中且非泛指），校验
// 不过或 AI 不可用即返回 null——fail-closed 回到普通召回，绝不误伤既有路由。
// count/finance 不接受 LLM 补路由：其 exact/fail_closed 口径与参数只能由
// 规则精确推导，误判会把「午饭花了多少钱」这类单项问题打成合计（R129 P2-a）。

export interface AskIntentResult {
  intent: "topic_enum" | "enum_list" | "extreme";
  topic: string | null;
  extreme: "earliest" | "latest" | "longest" | null;
}

const ASK_INTENT_SYSTEM = `你是个人笔记问答系统的意图分类器。用户在向自己的笔记库提问，请把问题分类为以下意图之一，只输出一行 JSON，不要输出任何其他文本：
- topic_enum：要求列举与某个具体主题相关的笔记/记录（例：「我看过哪些书」「列一下我存过的菜谱」「盘点一下我记过的菜谱」「AI 相关的记录都有什么」「给我一份读过的书的清单」）。输出 {"intent":"topic_enum","topic":"主题词"}；主题词必须是问题里出现的具体词（1-8 个字，如 书/菜谱/AI），不能是「东西/内容/事情/笔记/记录」这类泛指词；主题是「想去的地方」这类描述时，取笔记里最可能写到的词（「列一下我想去的地方」→ {"intent":"topic_enum","topic":"想去"}）。
- enum_list：要求列举某段时间记了什么，无主题限定（例：「上周都记了什么」「这个月的笔记清单」「最近记的都有什么」）。输出 {"intent":"enum_list"}
- extreme：问最早/最新/最长的一条笔记（例：「我的第一条笔记是什么」）。输出 {"intent":"extreme","extreme":"earliest"}（或 latest / longest）
- general：其他一切问题，包括：针对具体内容/事实的提问（是什么/为什么/什么时候）、要求归纳/梳理某主题的内容（「这个项目做过哪些关键决定」「健身计划有哪些调整」——问的是笔记里写了什么，不是要笔记清单）、数量统计、花销收入合计、单笔消费、闲聊。输出 {"intent":"general"}
拿不准时一律输出 {"intent":"general"}。`;

const ASK_INTENT_VALUES = new Set(["topic_enum", "enum_list", "extreme", "general"]);

// 枚举意图必须带显式列举措辞（fail-closed）：拦下 LLM 把「置身事内讲了什么」
// 这类内容型提问误判成 topic_enum 的假阳性——列举问法一定带列举线索词。
export const ASK_ENUM_CUE_RE = /哪些|列一下|列出|罗列|盘点|清单|列表|都有(?:什么|啥)|都记|都存|都写|所有|全部/;
const ASK_EXTREME_VALUES = new Set(["earliest", "latest", "longest"]);

/** 校验 LLM 给出的主题词：必须出现在原问题里、长度合理、非泛指词（fail-closed）。 */
export function validAskEnumTopic(topic: unknown, question: string): topic is string {
  return (
    typeof topic === "string" &&
    topic.length >= 1 &&
    topic.length <= 12 &&
    question.includes(topic) &&
    !TOPIC_ENUM_GENERIC_RE.test(topic)
  );
}

/**
 * LLM 统一意图分类（仅在全部规则未命中时调用）：识别措辞变体的枚举/极值
 * 问法。返回 null 表示 general、AI 不可用或输出未通过校验——调用方回落普通召回。
 */
export async function classifyAskIntent(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  question: string
): Promise<AskIntentResult | null> {
  const out = await chatComplete(env, {
    temperature: 0,
    max_tokens: 60,
    timeout_ms: 10_000,
    messages: [
      { role: "system", content: ASK_INTENT_SYSTEM },
      { role: "user", content: question.slice(0, 300) },
    ],
  });
  if (!out) return null;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: { intent?: unknown; topic?: unknown; extreme?: unknown };
  try {
    parsed = JSON.parse(m[0]) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.intent !== "string" || !ASK_INTENT_VALUES.has(parsed.intent)) return null;
  if (parsed.intent === "general") return null;
  if ((parsed.intent === "topic_enum" || parsed.intent === "enum_list") && !ASK_ENUM_CUE_RE.test(question)) return null;
  if (parsed.intent === "topic_enum") {
    if (!validAskEnumTopic(parsed.topic, question)) return null;
    return { intent: "topic_enum", topic: parsed.topic, extreme: null };
  }
  if (parsed.intent === "extreme") {
    if (typeof parsed.extreme !== "string" || !ASK_EXTREME_VALUES.has(parsed.extreme)) return null;
    return { intent: "extreme", topic: null, extreme: parsed.extreme as "earliest" | "latest" | "longest" };
  }
  return { intent: "enum_list", topic: null, extreme: null };
}

// ---- 枚举家族统一入口（R150 P1-1）----
// 主题枚举与时间窗枚举是唯一一对会在同一问句上同时命中的正则家族（「都记了
// 些什么」既像无主题枚举又可能被捕出主题碎片）。单独命中时保持正则直路由
// （行为与历史轮一致、零额外成本）；两个家族同时命中即视为跨规则歧义，交
// R132 统一分类器主判，正则偏好只做 LLM 不可用/校验不过时的 fail-closed 兜底。
// 两个正则都未命中时沿用 R132 的 LLM 补路由。财务/计数家族不参与：其参数与
// exact/fail_closed 口径只能由规则精确推导（见上），且从不与枚举家族互相误捕。

export interface AskEnumRoute {
  topic: string | null;
  list: boolean;
  extreme: "earliest" | "latest" | "longest" | null;
}

// 演化/脉络类问题（R172 P1，R149 起遗留）：「X 的想法是怎么变化的」「都有哪些
// 进展和变化」问的是内容随时间的演变，需要语义+时间线检索与按时间顺序生成，
// 不属于枚举家族——即使问句带「哪些/所有」这类列举线索词。此前该类问法会被
// topic_enum 关键词精确筛选短路（LIKE '%主题%' 漏掉没写到该词的相关笔记且
// 提前 return），在枚举入口最前面确定性放行到普通召回。
export const EVOLUTION_Q_RE = /怎么变|变化|演[变进化]|脉络|历程|轨迹|心路|来龙去脉|发展过程|进展/;

export async function resolveAskEnumIntent(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  question: string,
  recallQuestion: string
): Promise<AskEnumRoute> {
  if (EVOLUTION_Q_RE.test(question) || EVOLUTION_Q_RE.test(recallQuestion)) {
    return { topic: null, list: false, extreme: null };
  }
  const reTopic = topicEnumIntent(question) ?? topicEnumIntent(recallQuestion);
  const reList = enumListIntent(question) || enumListIntent(recallQuestion);
  if (reTopic && !reList) return { topic: reTopic, list: false, extreme: null };
  if (!reTopic && reList) return { topic: null, list: true, extreme: null };
  // 跨家族歧义（两者都命中）或全部未命中：LLM 统一分类主判
  const llm = await classifyAskIntent(env, question);
  if (llm?.intent === "topic_enum" && llm.topic) return { topic: llm.topic, list: false, extreme: null };
  if (llm?.intent === "enum_list") return { topic: null, list: true, extreme: null };
  if (llm?.intent === "extreme" && llm.extreme) return { topic: null, list: false, extreme: llm.extreme };
  // fail-closed 兜底：LLM 不可用/输出未过校验时保留既有正则偏好（主题优先）
  if (reTopic) return { topic: reTopic, list: false, extreme: null };
  if (reList) return { topic: null, list: true, extreme: null };
  return { topic: null, list: false, extreme: null };
}

// ---- 财务口径澄清追问（R130 P2-1）----
// 上一轮是精确合计答案时，「包括报销的差旅费吗」是一个是/否口径问题：找出
// 限定项对应的记账笔记，按 category 直答计入/不计入，绝不复读合计（R129 R14）。

/** 精确财务合计答案的标识（buildFinanceAggAnswer 尾注）。 */
const FINANCE_AGG_MARK_RE = /口径与周报\/月报一致/;

const FINANCE_CLARIFY_RE = /(?:包括|包含|算上了?|算进去?了?|算了)([\u4e00-\u9fa5A-Za-z0-9的]{2,16}?)(?:在内|以内|之内)?(?:的钱|的?开销)?(?:进去)?了?(?:吗|么|嘛|没有?|了吗|了没|不)?$/;

/** 财务口径澄清追问的限定词（「包括报销的差旅费吗」→ [报销, 差旅费]）；非此类返回 null。 */
export function financeClarifyTerms(question: string, lastAssistant: string | null): string[] | null {
  if (!lastAssistant || !FINANCE_AGG_MARK_RE.test(lastAssistant)) return null;
  const m = question.replace(/[？?。！!\s]+$/g, "").match(FINANCE_CLARIFY_RE);
  if (!m?.[1]) return null;
  // 代词/语气前缀与方位尾巴不是关键词（「你算上打车费在内了吗」→ 打车费）
  const terms = m[1]
    .split("的")
    .map((s) => s.trim().replace(/^(?:你|您|咱|都|也|把|将)+/, "").replace(/(?:在内|以内|之内|在)$/, ""))
    .filter((s) => s.length >= 2 && !/^(?:费用|开销|支出|收入|这个|那个|这些|那些)$/.test(s));
  return terms.length > 0 ? terms : null;
}

const CLARIFY_VERDICTS: Record<string, string> = {
  expense: "已计入支出合计",
  income: "已计入收入合计",
  transfer: "不计入收支合计（报销/借还/内转等资金往来只计笔数）",
};

/** 口径澄清的确定性答案：先直答是/否，再逐条说明计入与否，最后附精确合计口径。 */
export function buildFinanceClarifyAnswer(
  terms: string[],
  rows: Pick<NoteRow, "title" | "content" | "category" | "amount" | "currency">[],
  stats: FinanceStats,
  phrase: string | null
): string {
  let included = 0;
  let excluded = 0;
  const lines = rows.map((n, i) => {
    const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
    const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : null;
    let verdict: string;
    if (n.category === "transfer") {
      excluded++;
      verdict = CLARIFY_VERDICTS.transfer;
    } else if (!amount) {
      excluded++;
      verdict = "未识别出金额，未计入合计";
    } else {
      included++;
      verdict = CLARIFY_VERDICTS[n.category ?? ""] ?? "已计入合计";
    }
    return `- ${text}${amount ? `（${amount}）` : ""}——${verdict} [${i + 1}]`;
  });
  const head = excluded === 0 ? "包括。" : included === 0 ? "不包括。" : "部分包括。";
  return `${head}与「${terms.join("、")}」相关的记账记录：\n\n${lines.join("\n")}\n\n${buildFinanceAggAnswer(stats, phrase)}`;
}

const COUNT_CATEGORY_LABELS: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
  expense: "支出",
  income: "收入",
  transfer: "资金往来",
};

/** Exact count answer from SQL aggregation（含分类分布与加密笔记数）。 */
export function buildCountAnswer(
  total: number,
  byCategory: { category: string | null; cnt: number }[],
  sensitiveCount: number,
  phrase: string | null
): string {
  const scope = phrase ? `${phrase}` : "到目前为止";
  if (total === 0) return `${scope}你还没有记录任何笔记。`;
  const parts = byCategory
    .filter((r) => r.cnt > 0)
    .map((r) => `${r.category ? (COUNT_CATEGORY_LABELS[r.category] ?? r.category) : "待分类"} ${r.cnt} 条`);
  let answer = `${scope}你一共记了 ${total} 条笔记`;
  if (parts.length > 0) answer += `，其中：${parts.join("、")}`;
  answer += "。";
  if (sensitiveCount > 0) answer += `（含 ${sensitiveCount} 条加密的敏感笔记）`;
  answer += "\n\n以上为数据库精确统计（不含已删除笔记）。";
  return answer;
}

/** Fail-closed：计数措辞带主题限定，无法精确 SQL 化时拒绝猜数并给出可精确的总数。 */
export function buildCountFailClosedAnswer(
  total: number,
  byCategory: { category: string | null; cnt: number }[],
  sensitiveCount: number,
  phrase: string | null
): string {
  return (
    "这个计数问题带有主题/内容限定条件，暂不支持按限定条件精确计数；为避免从部分检索结果猜数出错，我不做估算。\n\n" +
    `${buildCountAnswer(total, byCategory, sensitiveCount, phrase)}\n\n` +
    "如需按主题查看，可在时间流搜索该关键词逐条确认。"
  );
}

// ---- 拒答建议主题相关性（R118 P2，R117 §四-2）----
// 建议列表与「找到了相关的笔记」口径都必须以主题词命中为准：语义分上
// “花钱类”笔记会压过真正的主题笔记（理发），零召回时弱命中也会被误称
// “相关”。从检索词里剥掉时间/聚合/财务/语气词后剩下的才是主题词。

/** Strip time/aggregate/finance/filler wording from recall terms, keeping only topic words. */
export function askTopicTerms(terms: string[]): string[] {
  const out: string[] = [];
  for (const t of terms) {
    let r = t;
    for (const re of STRIP_RES) r = r.replace(re, "");
    if (r.length >= 2 && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Whether a note textually contains any of the topic terms (title/content/tags). */
export function noteHitsTopic(
  note: Pick<NoteRow, "title" | "content" | "tags">,
  topics: string[]
): boolean {
  if (topics.length === 0) return false;
  const hay = `${note.title ?? ""}\n${note.content}\n${note.tags ?? ""}`;
  return topics.some((t) => hay.includes(t));
}

/** Fail-closed answer: no arithmetic on the qualified subset, exact overall stats instead. */
export function buildFinanceFailClosedAnswer(stats: FinanceStats, phrase: string | null): string {
  return (
    "这个合计问题带有额外限定条件，暂不支持按限定条件精确合计；为避免估算出错（尤其多币种不能直接相加），我不做心算合计。\n\n" +
    `${buildFinanceAggAnswer(stats, phrase)}\n\n` +
    "如需细看某一项，可在时间流搜索关键词逐条查看，或到「报告」页查看周报/月报的分类统计。"
  );
}

/** Deterministic answer for finance aggregate questions, built from financeStats (report口径). */
export function buildFinanceAggAnswer(stats: FinanceStats, phrase: string | null): string {
  const scope = phrase ?? "全部笔记";
  if (stats.expenseCount === 0 && stats.incomeCount === 0) {
    const transferNote = stats.transferCount > 0 ? `另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支。` : "";
    return `${scope}没有记账记录（支出/收入均为 0 笔）。${transferNote}`;
  }
  const lines = Object.entries(stats.totals).map(
    ([cur, t]) =>
      `- ${cur}：支出 ${formatAmount(t.expense, cur)}，收入 ${formatAmount(t.income, cur)}，结余 ${formatAmount(t.income - t.expense, cur)}`
  );
  let md = `${scope}共记录 ${stats.expenseCount} 笔支出、${stats.incomeCount} 笔收入。\n${lines.join("\n")}`;
  if (stats.unknownAmount > 0) md += `\n（另有 ${stats.unknownAmount} 笔未识别出金额，未计入合计。）`;
  if (stats.transferCount > 0) md += `\n（另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支合计。）`;
  md += `\n\n以上为精确统计，口径与周报/月报一致${phrase ? "；时间范围按笔记记录时间划定，不按正文里写的时间" : ""}。`;
  return md;
}

/** True when a note's created_at (UTC sql string) falls inside the range. */
export function inTimeRange(createdAt: string, range: TimeRange): boolean {
  if (range.start && createdAt < range.start) return false;
  if (range.end && createdAt >= range.end) return false;
  return true;
}

/**
 * Relation/follow-up wording whose answer usually spans two notes (多跳：首轮
 * 命中的笔记 + 与它因果/对应的第二跳笔记)。Gates the second-pass seeded
 * semantic recall in /api/ask so single-hop questions pay no extra latency.
 */
export const MULTI_HOP_RE = /关系|关联|依据|后来|进展|着落|落地|来龙去脉|脉络|演化|一体|同一|对得上|接上|呼应|前提|支撑/;

/** Cosine similarity below which a semantic-only recall hit is too weak to appear as a citation. */
export const ASK_CITATION_MIN_SCORE = 0.55;

/**
 * Cosine similarity floor for the "相近的记录" suggestions attached to a 没找到
 * answer: below this the note is essentially unrelated (宁缺毋滥) and only
 * erodes trust when suggested.
 */
export const ASK_SUGGESTION_MIN_SCORE = 0.4;

const CITE_RE = /[\[［](\d{1,2})[\]］]/g;

// 引用导言后面的 [n] 被剔除后会留下「参见 ，」这种空位；把悬空的导言词、
// 空括号和叠在一起的标点一并清掉，保证答案文本不出现断尾引用格式。
const DANGLING_LEADIN_RE = /(?:另?可?参见|详见|根据|结合)[\s　]*(?=$|[，。；、！？,.;!?)）\]】])/g;
function cleanDanglingCitations(s: string): string {
  return s
    // orphan 「和/及/以及/与」 left between a removed marker and punctuation
    // (「根据 [1]、[2]、 和 ，」→「根据 [1]、[2]，」)
    .replace(/[、，]?[\s　]*(?:和|及|以及|与)[\s　]*(?=$|[，。；、！？,.;!?)）\]】])/g, "")
    .replace(DANGLING_LEADIN_RE, "")
    // orphan 、/， left where a removed marker preceded a surviving one
    .replace(/(^|[\s　（(：:])[、，][\s　]*(?=[\[［])/g, "$1")
    .replace(/（[\s　]*）|\([\s　]*\)/g, "")
    .replace(/[\s　]*([，。；、！？])[\s　]*(?=[，。；、！？])/g, "")
    .replace(/^[\s　]*[，、；][\s　]*/, "")
    // a citation verb stranded at the start by a removed leading marker
    // (「[2] 提到医生开的降压药」→「 提到医生开的降压药」)
    .replace(/^[\s　]+/, "")
    .replace(/^(?:中|里)?(提到|写道|记录了|显示)/, "笔记里$1");
}

/**
 * 同内容重复笔记（写入端历史重复/重复剪藏）在 Ask 引用列表并列多引只增冗余
 * 不增信息：按内容精确聚合（与 import_fp 同口径），只保留排序最靠前的一条
 * 进入上下文与引用（R163 设计建议 3）。
 */
export function dedupeNotesByContent<T extends { content: string }>(notes: T[]): T[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const key = n.content.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Single source of truth for /api/ask citations: the answer text and the
 * references array are rewritten together so every [n] marker left in the
 * answer maps to exactly one returned reference card.
 *
 * - [n] markers cite the prompt snippet order (1-based over `noteIds`).
 * - Weak semantic-only sources (low-score recall that never matched a keyword)
 *   are dropped from the citations AND their markers removed from the text —
 *   unless that would leave the answer with zero references.
 * - Out-of-range markers (model hallucination) are removed from the text.
 * - Surviving citations are renumbered 1..k in first-citation order, both in
 *   the text and in the returned references.
 * - With no [n] markers at all, all recalled notes (minus weak ones) are
 *   returned as references so the client can still show sources.
 */
export function reconcileAskCitations(
  answer: string,
  noteIds: string[],
  weakIds: ReadonlySet<string>
): { answer: string; references: { index: number; note_id: string }[] } {
  const cited: number[] = [];
  for (const m of answer.matchAll(CITE_RE)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= noteIds.length && !cited.includes(n)) cited.push(n);
  }
  if (cited.length === 0) {
    const strong = noteIds.filter((id) => !weakIds.has(id));
    const list = strong.length > 0 ? strong : noteIds;
    // hallucinated out-of-range markers still get stripped from the text
    const cleaned = cleanDanglingCitations(answer.replace(CITE_RE, ""));
    return { answer: cleaned, references: list.map((id, i) => ({ index: i + 1, note_id: id })) };
  }
  let keep = cited.filter((n) => !weakIds.has(noteIds[n - 1]));
  if (keep.length === 0) keep = cited;
  const renumber = new Map(keep.map((n, i) => [n, i + 1] as const));
  const rewritten = answer.replace(CITE_RE, (_marker, d: string) => {
    const nn = renumber.get(parseInt(d, 10));
    return nn ? `[${nn}]` : "";
  });
  return {
    answer: cleanDanglingCitations(rewritten),
    references: keep.map((n) => ({ index: renumber.get(n)!, note_id: noteIds[n - 1] })),
  };
}

const REFUSAL_PHRASE_RE = /没有?找到|没有相关|没有记录|未找到|找不到|没记过|没有这方面|没有笔记|没提到|未提及|没有提及/;

// ---- 否定话术实体后校验（R200，audit-r199 P3-1）----
// R198 已在 prompt 中约束「没提到」类否定话术只能复述问句/片段里出现过的
// 实体，但 LLM 路径无法保证 100% 服从（生产残留：「没有提到手机壳是在
// 淘宝买的」「没有提到具体是人民公园」——淘宝/人民公园均未出现）。这里做
// 确定性输出侧收口：否定分句的宾语里出现问句与片段中都不存在的实体串时，
// 整个宾语改写成不引入任何新实体的通用指代。误伤（同义改述被改写成通用
// 指代）只损失一点具体性，仍然诚实；漏判只剩单字实体与恰好是原文
// 子串的实体，均不构成「编造实体」。

const NEGATION_CLAUSE_RE =
  /(没有?|未|不曾)((?:具体|明确)?(?:提到|提及|说明|写明|写到|写清|记录|标注|注明|指明)(?:过)?(?:具体)?(?:是)?)([^，。；！？!?\n]{1,40})/g;

// 宾语切块的功能字/疑问代词/引用角标：切完剩下的 ≥2 字块才是实体候选
const NEGATION_SPLIT_RE =
  /[\[［]\d{1,2}[\]］]|[是在的了吗么呢啊吧其到底和或与从由给对被把你我他她它们这那哪谁]|什么|怎么|为何|以及|还有|具体|明确|\s+/g;

// 泛指属性名词不是实体（问句常以别的说法问同一属性，如「多少钱」→「价格」）
const NEGATION_GENERIC_RE =
  /^(?:价格|价钱|金额|费用|多少钱|品牌|牌子|型号|颜色|地点|地方|位置|时间|日期|时候|原因|名字|名称|店铺|店名|商家|平台|渠道|来源|信息|细节|内容|数量|大小|尺寸|款式|口味|购买|地址|哪里|哪儿|买的)$/;

// 无来源金额后校验（R200 生产 QA 实测）：肯定句里编造金额（「周六和周日各花
// 20 元买菜」，笔记原文只有「超市买菜花了 82.5 元」）不在否定分句捕获范围内。
// 金额是笔记问答里最不允许编造的事实：答案中「数字+币种」token 的数值若在
// 问句与召回片段中都不存在，整句剥除（宁可少说、不可编造）；全被剥空则由
// 调用方回落诚实拒答通道。数字比对带边界（20 不匹配 2026/820），千分位与
// 尾零归一（8,000≒8000、82.50≒82.5）。
const ANSWER_AMOUNT_RE =
  /[¥￥$€£]\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:元|块钱?|人民币|美元|美金|日元|欧元|英镑|港[币元]|韩元|rmb|cny|usd|jpy|eur|gbp|hkd|krw)/gi;

export function scrubUnsourcedAmounts(answer: string, source: string): string {
  const src = source.replace(/,/g, "");
  const sourced = (raw: string): boolean => {
    const plain = raw.replace(/,/g, "");
    const n = Number(plain);
    if (!Number.isFinite(n)) return true;
    const variants = new Set([plain, String(n)]);
    for (const v of variants) {
      if (new RegExp(`(?<![\\d.])${v.replace(".", "\\.")}(?!\\d)`).test(src)) return true;
    }
    return false;
  };
  return answer
    .split(/(?<=[。！？!?\n])/)
    .filter((sentence) => {
      for (const m of sentence.matchAll(ANSWER_AMOUNT_RE)) {
        const num = m[1] ?? m[2];
        if (num && !sourced(num)) return false;
      }
      return true;
    })
    .join("");
}

/** 否定分句引入了问句与片段中都不存在的实体时，把宾语改写成通用指代。 */
export function scrubUnsourcedNegations(answer: string, source: string): string {
  return answer.replace(NEGATION_CLAUSE_RE, (whole, neg: string, verb: string, obj: string) => {
    const chunks = obj
      .split(NEGATION_SPLIT_RE)
      .map((s) => (s ?? "").trim())
      .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,}$/.test(s) && !NEGATION_GENERIC_RE.test(s));
    const invented = chunks.some((c) => !source.includes(c));
    return invented ? `${neg}${verb}你问的这个信息` : whole;
  });
}

/** The model's answer amounts to "没找到": either it carries no [n] citations,
 * or（R183 P1-3）it is a pure single-sentence denial that still carries [n]
 * markers（「没提到关于洗牙的记录 [1] [2] [3]」）——否认+引用自相矛盾，按拒答
 * 处理走复问/诚实拒答通道。带转折的部分否认（「没找到电费，但 [2] 提到房租」）
 * 是正常答案，不算拒答。 */
export function isRefusalAnswer(answer: string): boolean {
  const hasCitation = /[\[［]\d{1,2}[\]］]/.test(answer);
  if (!hasCitation) return REFUSAL_PHRASE_RE.test(answer);
  const stripped = answer.replace(CITE_RE, "").trim();
  if (!REFUSAL_PHRASE_RE.test(stripped)) return false;
  if (/但是?|不过|然而|however/i.test(stripped)) return false;
  const sentences = stripped.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
  return sentences.length === 1;
}

export const NO_ANSWER_TEXT = "没找到相关笔记。";

/**
 * Honest pointer for encrypted sensitive notes that matched the recall terms:
 * only a count and a search entry point — never titles or content. The same
 * information (masked hits) is already public on the search page.
 */
export function sensitiveHintLine(count: number, terms: string[]): string {
  if (count <= 0) return "";
  const kw = terms.filter((t) => t.length <= 20).slice(0, 2).join(" ");
  const where = kw ? `搜索「${kw}」` : "搜索相关关键词";
  return `\n\n另有 ${count} 条加密的敏感笔记可能相关（内容不会进入问答），可到时间流${where}后点击解锁查看。`;
}

/**
 * 凭据类问法（密码/私钥/助记词等）。R147 P2-1：这类问题按关键词匹配不到
 * 敏感笔记元数据时（敏感笔记正文加密、常无标题），拒答分支既无敏感提示
 * 又引无关笔记——同一意图两种体验。识别出凭据意图后统一给敏感指引。
 */
export const CREDENTIAL_Q_RE = /密码|口令|私钥|助记词|恢复码|密钥|passwords?|passphrase|secret key|pin\s?码/i;

/**
 * 敏感兜底指引（R190 P1-2，与 R188 凭据口径同一分支架构）：关键词没匹配上
 * 敏感元数据时不含计数（会误导），只给解锁/搜索入口。不再依赖凭据关键词
 * 词典决定给不给（「储物柜暗号」这类问法命中不了词典）：凭据问法仅措辞
 * 更具体（原图确认提示）。
 */
export function sensitiveFallbackHintLine(credential: boolean): string {
  const subject = credential ? "账号密码这类信息" : "要找的内容";
  const tail = credential ? "（拍照记的凭证还可打开笔记里的原图确认）" : "";
  return `\n\n提示：${subject}如果记成了加密的敏感笔记，内容不会进入问答；可到时间流搜索相关关键词后点击解锁查看${tail}。`;
}

/** 凭据类问法的兜底指引（sensitiveFallbackHintLine 的凭据措辞）。 */
export function credentialHintLine(): string {
  return sensitiveFallbackHintLine(true);
}

/**
 * Build the explicit refusal answer, with up to 3 nearby notes as suggestions
 * ("相近的记录" the user might have meant). Suggestions map to references so
 * the client renders them as cards.
 *
 * `mode` keeps the wording honest (R115 P2 拒答口径失真)：
 * - "no_recall": nothing was retrieved at all — 「没找到相关笔记」 is literally true.
 * - "not_in_notes": recall DID hit topic notes but none contains the asked
 *   detail — saying 「没找到」 would be false; say the notes don't mention it.
 */
export function buildNoAnswerResponse(
  suggestions: Pick<NoteRow, "id" | "title" | "content">[],
  mode: "no_recall" | "not_in_notes" = "no_recall"
): {
  answer: string;
  references: { index: number; note_id: string }[];
} {
  if (suggestions.length === 0) {
    return { answer: `${NO_ANSWER_TEXT}换个说法（补充关键词或时间，如「上个月」「关于XX」）再试试。`, references: [] };
  }
  const lines = suggestions.slice(0, 3).map((n, i) => {
    const label = (n.title || n.content).replace(/\s+/g, " ").slice(0, 40);
    return `[${i + 1}] ${label}`;
  });
  const lead =
    mode === "not_in_notes"
      ? "找到了相关的笔记，但里面没有提到你问的这个信息："
      : `${NO_ANSWER_TEXT}以下是几条相近的记录，可能是你想找的：`;
  return {
    answer: `${lead}\n${lines.join("\n")}`,
    references: suggestions.slice(0, 3).map((n, i) => ({ index: i + 1, note_id: n.id })),
  };
}
