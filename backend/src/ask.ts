import type { Env, NoteRow } from "./types";
import { formatAmount, type FinanceStats } from "./reports";
import { chatComplete } from "./ai";

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
  if (isFinanceAggQuestion(question)) return "exact";
  if (FACT_QUERY_RE.test(question)) return null;
  if (FINANCE_WORD_RE.test(question) && STRONG_AGG_RE.test(question)) return "fail_closed";
  return null;
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
}

/** 识别财务极值问题（最贵/最大/最小一笔支出、金额最高的收入等）。 */
export function financeExtremeIntent(question: string): FinanceExtremeQuery | null {
  if (!FINANCE_WORD_RE.test(question) && !/买/.test(question)) return null;
  const direction: "expense" | "income" = /收入|进账|入账|赚|挣/.test(question) ? "income" : "expense";
  if (/最贵|最高|最大的?一?[笔项]|金额最[大高]|花得?最多|花钱最[狠多猛]|最狠的?一[笔次]|数额最大/.test(question)) return { kind: "max", direction };
  if (/最便宜|最低|最小的?一?[笔项]|金额最[小低]|花得?最少|数额最小/.test(question)) return { kind: "min", direction };
  return null;
}

const FINANCE_DIRECTION_LABELS: Record<"expense" | "income", string> = { expense: "支出", income: "收入" };

/** 财务极值的确定性答案：按币种分组比较，敏感笔记只报金额/时间不露内容。 */
export function buildFinanceExtremeAnswer(
  query: FinanceExtremeQuery,
  rows: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "is_sensitive" | "amount" | "currency">[],
  unknownAmount: number,
  phrase: string | null
): string {
  const scope = phrase ?? "全部笔记";
  const label = FINANCE_DIRECTION_LABELS[query.direction];
  const kindLabel = query.kind === "max" ? "金额最大" : "金额最小";
  if (rows.length === 0) {
    return `${scope}没有已识别出金额的${label}记录，无法比较金额大小。${unknownAmount > 0 ? `（另有 ${unknownAmount} 笔${label}未识别出金额。）` : ""}`;
  }
  const lines = rows.map((n, i) => {
    const amount = formatAmount(n.amount ?? 0, n.currency || "CNY");
    const when = formatShanghai(n.created_at);
    const desc = n.is_sensitive
      ? "（加密的敏感笔记，内容不在问答中展示）"
      : `：${(n.title || n.content).replace(/\s+/g, " ").slice(0, 60)}`;
    const cite = n.is_sensitive ? "" : ` [${i + 1}]`;
    return rows.length === 1
      ? `你${kindLabel}的一笔${label}是 ${amount}（${when}，北京时间）${cite}${desc}`
      : `- ${n.currency || "CNY"}：${amount}（${when}，北京时间）${cite}${desc}`;
  });
  let md = rows.length === 1 ? lines[0] : `${scope}按币种分别比较（不同币种金额不可直接比较），${kindLabel}的${label}：\n${lines.join("\n")}`;
  md += `\n\n以上为数据库精确查询结果（按已识别金额比较，不含已删除笔记${unknownAmount > 0 ? `；另有 ${unknownAmount} 笔未识别出金额，未参与比较` : ""}）。`;
  return md;
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
  if (!FINANCE_WORD_RE.test(question) || !SUBSET_AGG_RE.test(question)) return null;
  let residual = question;
  for (const re of STRIP_RES) residual = residual.replace(re, "");
  // 时间限定词不属于主题（「2026年7月咖啡」→「咖啡」）：时间过滤由
  // parseTimeRange 负责，残留的年月日 token 一律剥掉
  residual = residual.replace(/\d{2,4}\s*年|\d{1,2}\s*月(?:份)?|\d{1,2}\s*[日号]|上+个?[月周]|这个?[月周]|本[月周]|最近|今年|去年|前年/g, "");
  // 剥掉开头的购买/消费动词（「买咖啡」→「咖啡」），但不能把「吃喝」这类
  // 本身就是主题的词剥空
  const stripped = residual.replace(/^[买在喝吃点逛去为给用出]{1,2}/, "");
  if (stripped.length >= 2) residual = stripped;
  const terms = residual
    .split(/和|跟|以及|、/)
    .map((s) => s.trim())
    .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) && !TOPIC_ENUM_GENERIC_RE.test(s));
  return terms.length > 0 && terms.length <= 3 ? terms : null;
}

/** 财务主题子集的精确合计答案：逐笔明细 + 按币种合计，敏感笔记计入合计但不展示内容。 */
export function buildFinanceSubsetAnswer(
  terms: string[],
  rows: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "category" | "is_sensitive" | "amount" | "currency">[],
  phrase: string | null
): string {
  const scope = phrase ?? "到目前为止";
  const kw = terms.join("、");
  const finance = rows.filter((n) => n.category === "expense" || n.category === "income");
  const totals: Record<string, { expense: number; income: number }> = {};
  let expenseCount = 0;
  let incomeCount = 0;
  let unknown = 0;
  for (const n of finance) {
    if (typeof n.amount !== "number" || !Number.isFinite(n.amount)) {
      unknown++;
      continue;
    }
    const cur = n.currency || "CNY";
    totals[cur] ??= { expense: 0, income: 0 };
    if (n.category === "expense") {
      totals[cur].expense += n.amount;
      expenseCount++;
    } else {
      totals[cur].income += n.amount;
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
    const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
    const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
    return `- ${text}（${amount}，${formatShanghai(n.created_at).slice(0, 10)}）[${i + 1}]`;
  });
  const sensitiveCnt = finance.filter((n) => n.is_sensitive).length;
  let md = `按关键词「${kw}」精确匹配（标题/正文/标签），${scope}共 ${expenseCount} 笔支出${incomeCount > 0 ? `、${incomeCount} 笔收入` : ""}：\n${totalLines.join("\n")}`;
  if (itemLines.length > 0) md += `\n\n逐笔明细${finance.length > visible.length ? `（共 ${finance.length} 笔，仅展示前 ${visible.length} 笔）` : ""}：\n${itemLines.join("\n")}`;
  if (sensitiveCnt > 0) md += `\n（含 ${sensitiveCnt} 笔加密的敏感记录，金额已计入合计，内容不在问答中展示。）`;
  if (unknown > 0) md += `\n（另有 ${unknown} 笔未识别出金额，未计入合计。）`;
  md += `\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。如果你的记录用了别的说法，换个关键词再问试试。`;
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

export async function resolveAskEnumIntent(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  question: string,
  recallQuestion: string
): Promise<AskEnumRoute> {
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

const FINANCE_CLARIFY_RE = /(?:包括|包含|算上了?|算进去?了?|算了)([\u4e00-\u9fa5A-Za-z0-9的]{2,16}?)(?:的钱|的?开销)?(?:吗|么|嘛|没有?|了吗|了没|不)?$/;

/** 财务口径澄清追问的限定词（「包括报销的差旅费吗」→ [报销, 差旅费]）；非此类返回 null。 */
export function financeClarifyTerms(question: string, lastAssistant: string | null): string[] | null {
  if (!lastAssistant || !FINANCE_AGG_MARK_RE.test(lastAssistant)) return null;
  const m = question.replace(/[？?。！!\s]+$/g, "").match(FINANCE_CLARIFY_RE);
  if (!m?.[1]) return null;
  const terms = m[1]
    .split("的")
    .map((s) => s.trim())
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
  md += `\n\n以上为精确统计，口径与周报/月报一致。`;
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

/** The model's answer amounts to "没找到" (no [n] citations backing anything). */
export function isRefusalAnswer(answer: string): boolean {
  const hasCitation = /[\[［]\d{1,2}[\]］]/.test(answer);
  return !hasCitation && /没有?找到|没有相关|没有记录|未找到|找不到|没记过|没有这方面|没有笔记|没提到|未提及|没有提及/.test(answer);
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

/** 凭据类问法的兜底指引（不含计数：关键词没匹配上，计数会误导）。 */
export function credentialHintLine(): string {
  return "\n\n提示：账号密码这类信息如果记成了加密的敏感笔记，内容不会进入问答；可到时间流搜索相关关键词后点击解锁查看。";
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
