import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";
import { DEFAULT_TZ, loadUserTz, tzOffsetMs, tzOffsetMinutes, tzSqlModifier } from "./triage";
import { localDateOf, parseCreatedAt } from "./stats";
import { scrubAnswerLinks, execOutletTag, noteContainsExecutableCommand, EXEC_OUTLET_WARN_TAG } from "./prompt-armor";
import { bumpGuardEvents } from "./guard-events";

/** R306 P0-1：周报/月报行级危险标注（audit-r305 §3：周报原样带出 curl|bash 无警示）。 */
function execLinePrefix(n: Pick<NoteRow, "content">): string {
  const tag = execOutletTag(n.content);
  return tag ? `${tag} ` : "";
}

/**
 * 报告全文兜底：LLM 叙述可能逐字引用笔记里的命令，逐行补危险标注（已标注行
 * 不重复）；再在一级标题后插入本期危险笔记计数警示。返回标注后的 md 与命中行数。
 */
export function markExecInReport(md: string, dangerousNotes: number): { md: string; markedLines: number } {
  let markedLines = 0;
  const lines = md.split("\n").map((line) => {
    if (!line.trim() || line.includes(EXEC_OUTLET_WARN_TAG) || /^#{1,6}\s/.test(line)) return line;
    if (!noteContainsExecutableCommand(line)) return line;
    markedLines++;
    const m = /^(\s*(?:[-*+]|\d+\.|>)\s+)?(.*)$/s.exec(line);
    return `${m?.[1] ?? ""}${EXEC_OUTLET_WARN_TAG} ${m?.[2] ?? line}`;
  });
  let out = lines.join("\n");
  if ((dangerousNotes > 0 || markedLines > 0) && !/^> ⚠️ 本期有 \d+ 条笔记含可执行命令/m.test(out)) {
    const notice = `> ⚠️ 本期有 ${Math.max(dangerousNotes, 1)} 条笔记含可执行命令/危险指令，报告中涉及的命令仅供查阅，请勿直接执行。`;
    out = out.replace(/^(# [^\n]*\n)/, `$1\n${notice}\n`);
    if (!out.includes(notice)) out = `${notice}\n\n${out}`;
  }
  return { md: out, markedLines };
}

const SH_OFFSET_MS = 8 * 3600 * 1000;

/**
 * Week boundaries in the user's timezone (offsetMs east of UTC) for "last
 * week" relative to `now`: { weekStart, weekEnd } as YYYY-MM-DD (Mon..Sun).
 */
export function lastWeekRange(now: Date = new Date(), offsetMs: number = SH_OFFSET_MS): { weekStart: string; weekEnd: string } {
  const sh = new Date(now.getTime() + offsetMs);
  const dow = sh.getUTCDay(); // 0=Sun
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - daysSinceMonday));
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400 * 1000);
  const lastSunday = new Date(thisMonday.getTime() - 1 * 86400 * 1000);
  return { weekStart: lastMonday.toISOString().slice(0, 10), weekEnd: lastSunday.toISOString().slice(0, 10) };
}

/** Current week (Monday..today) in the user's timezone. */
export function thisWeekRange(now: Date = new Date(), offsetMs: number = SH_OFFSET_MS): { weekStart: string; weekEnd: string } {
  const sh = new Date(now.getTime() + offsetMs);
  const daysSinceMonday = (sh.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - daysSinceMonday));
  return { weekStart: monday.toISOString().slice(0, 10), weekEnd: sh.toISOString().slice(0, 10) };
}

/** Previous calendar month in the user's timezone as [monthStart, monthEnd] (both inclusive, YYYY-MM-DD). */
export function lastMonthRange(now: Date = new Date(), offsetMs: number = SH_OFFSET_MS): { monthStart: string; monthEnd: string } {
  const sh = new Date(now.getTime() + offsetMs);
  const first = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), 0));
  return { monthStart: first.toISOString().slice(0, 10), monthEnd: last.toISOString().slice(0, 10) };
}

/** Current calendar month (1st..today) in the user's timezone. */
export function thisMonthRange(now: Date = new Date(), offsetMs: number = SH_OFFSET_MS): { monthStart: string; monthEnd: string } {
  const sh = new Date(now.getTime() + offsetMs);
  const first = new Date(Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), 1));
  return { monthStart: first.toISOString().slice(0, 10), monthEnd: sh.toISOString().slice(0, 10) };
}

const CATEGORY_LABEL: Record<string, string> = { idea: "想法", todo: "待办", collect: "收藏", data: "资料", expense: "支出", income: "收入", transfer: "资金往来" };

/** Escape user-controlled text embedded into fallback markdown so it can never carry HTML/code into the renderer. */
export function escapeMdText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "'");
}

/**
 * 期段聚合行（按 分类×币种 分组）：总数/分类计数/收支合计的权威口径。
 * 统计走 SQL 聚合而非 LIMIT 截断后的笔记数组，重度用户（>1000 条/月）
 * 的月报金额不再无提示低估；LIMIT 只约束展示摘要。
 */
export interface PeriodAggRow {
  category: string;
  currency: string;
  cnt: number;
  sensitive: number;
  todo_done_cnt: number;
  amount_total: number;
  unknown_amount: number;
}

export async function aggregatePeriod(
  env: Env,
  userId: string,
  tzModifier: string,
  start: string,
  end: string
): Promise<PeriodAggRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(category, 'idea') AS category, COALESCE(currency, 'CNY') AS currency,
            COUNT(*) AS cnt, SUM(is_sensitive) AS sensitive,
            SUM(CASE WHEN todo_done = 1 THEN 1 ELSE 0 END) AS todo_done_cnt,
            SUM(CASE WHEN amount IS NOT NULL THEN amount ELSE 0 END) AS amount_total,
            SUM(CASE WHEN category IN ('expense','income') AND amount IS NULL THEN 1 ELSE 0 END) AS unknown_amount
     FROM notes WHERE user_id = ? AND deleted_at IS NULL
       AND datetime(created_at, ?) >= datetime(? || ' 00:00:00')
       AND datetime(created_at, ?) <= datetime(? || ' 23:59:59')
     GROUP BY 1, 2`
  )
    .bind(userId, tzModifier, start, tzModifier, end)
    .all<PeriodAggRow>();
  return results ?? [];
}

export function financeStatsFromAgg(rows: PeriodAggRow[]): FinanceStats {
  const stats: FinanceStats = { expenseCount: 0, incomeCount: 0, transferCount: 0, totals: {}, unknownAmount: 0 };
  for (const r of rows) {
    if (r.category === "transfer") {
      stats.transferCount += r.cnt;
      continue;
    }
    if (r.category !== "expense" && r.category !== "income") continue;
    if (r.category === "expense") stats.expenseCount += r.cnt;
    else stats.incomeCount += r.cnt;
    stats.unknownAmount += r.unknown_amount;
    const counted = r.cnt - r.unknown_amount;
    if (counted > 0) {
      if (!stats.totals[r.currency]) stats.totals[r.currency] = { expense: 0, income: 0 };
      stats.totals[r.currency][r.category as "expense" | "income"] += r.amount_total;
    }
  }
  return stats;
}

export function categoryCountsFromAgg(rows: PeriodAggRow[]): { total: number; counts: Map<string, number>; sensitive: number } {
  const counts = new Map<string, number>();
  let total = 0;
  let sensitive = 0;
  for (const r of rows) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + r.cnt);
    total += r.cnt;
    sensitive += r.sensitive;
  }
  return { total, counts, sensitive };
}

export interface TodoStats {
  created: number;
  createdDone: number;
  doneInWeek: number;
  openTitles: string[];
  doneTitles: string[];
}

/** Count the week's todo activity: new todos, how many of them are done, plus everything completed during the week. */
export async function todoStatsForWeek(
  env: Env,
  userId: string,
  weekStart: string,
  weekEnd: string,
  weekNotes: NoteRow[],
  tzModifier: string = "+480 minutes"
): Promise<TodoStats> {
  const todos = weekNotes.filter((n) => n.category === "todo");
  const doneRows = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL AND category = 'todo' AND todo_done = 1 AND done_at IS NOT NULL
       AND datetime(done_at, ?) >= datetime(? || ' 00:00:00')
       AND datetime(done_at, ?) <= datetime(? || ' 23:59:59')
     LIMIT 100`
  )
    .bind(userId, tzModifier, weekStart, tzModifier, weekEnd)
    .all<NoteRow>();
  const done = (doneRows.results ?? []).filter((n) => !n.is_sensitive);
  const title = (n: NoteRow) => `${execLinePrefix(n)}${escapeMdText((n.title || n.content).slice(0, 40))}`;
  return {
    created: todos.length,
    createdDone: todos.filter((n) => n.todo_done).length,
    doneInWeek: done.length,
    openTitles: todos.filter((n) => !n.todo_done && !n.is_sensitive).map(title).slice(0, 10),
    doneTitles: done.map(title).slice(0, 10),
  };
}

export function todoSection(stats: TodoStats, unit: string = "本周"): string {
  let md = `\n## 待办盘点\n${unit}新增待办 ${stats.created} 条，共完成 ${stats.doneInWeek} 条。\n`;
  if (stats.doneTitles.length > 0) {
    md += `\n已完成：\n`;
    for (const t of stats.doneTitles) md += `- [x] ${t}\n`;
  }
  if (stats.openTitles.length > 0) {
    md += `\n未完成：\n`;
    for (const t of stats.openTitles) md += `- [ ] ${t}\n`;
  }
  return md;
}

export interface FinanceStats {
  expenseCount: number;
  incomeCount: number;
  /** 资金平移（内转/提现/借入）笔数：只报告笔数，金额永不计入收支合计。 */
  transferCount: number;
  /** Totals per currency, e.g. { CNY: { expense: 123, income: 0 } }. Only counts notes with a known amount. */
  totals: Record<string, { expense: number; income: number }>;
  /** Finance notes without an extractable amount (excluded from totals). */
  unknownAmount: number;
}

/** Sum the period's expense/income notes per currency. */
export function financeStats(periodNotes: NoteRow[]): FinanceStats {
  const stats: FinanceStats = { expenseCount: 0, incomeCount: 0, transferCount: 0, totals: {}, unknownAmount: 0 };
  for (const n of periodNotes) {
    if (n.category === "transfer") {
      // 资金平移只计笔数，金额不污染收支合计
      stats.transferCount++;
      continue;
    }
    if (n.category !== "expense" && n.category !== "income") continue;
    if (n.category === "expense") stats.expenseCount++;
    else stats.incomeCount++;
    if (typeof n.amount === "number" && Number.isFinite(n.amount)) {
      const cur = n.currency || "CNY";
      if (!stats.totals[cur]) stats.totals[cur] = { expense: 0, income: 0 };
      stats.totals[cur][n.category] += n.amount;
    } else {
      stats.unknownAmount++;
    }
  }
  return stats;
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "JP¥", HKD: "HK$" };

export function formatAmount(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency];
  const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return sym ? `${sym}${num}` : `${num} ${currency}`;
}

export function financeSection(stats: FinanceStats): string {
  if (stats.expenseCount === 0 && stats.incomeCount === 0 && stats.transferCount === 0) return "";
  let md = `\n## 收支合计\n本期记了 ${stats.expenseCount} 笔支出、${stats.incomeCount} 笔收入。\n`;
  for (const [cur, t] of Object.entries(stats.totals)) {
    md += `- ${cur}：支出 ${formatAmount(t.expense, cur)}，收入 ${formatAmount(t.income, cur)}，结余 ${formatAmount(t.income - t.expense, cur)}\n`;
  }
  if (stats.unknownAmount > 0) md += `- 另有 ${stats.unknownAmount} 笔未识别出金额，未计入合计\n`;
  if (stats.transferCount > 0) md += `- 另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支\n`;
  return md;
}

/** 报告提示词的收藏小节指令（R180 P2-2）：期段内没有可展示的收藏时明确禁止
 * 生成「值得回顾的收藏」小节——无条件索要该节会让模型硬凑编造（忠实性原则）。 */
export function collectSectionPrompt(visibleCollects: number): string {
  return visibleCollects > 0
    ? "；4.「## 值得回顾的收藏」——挑出值得再看的收藏并说一句为什么值得"
    : "。本期没有收藏类记录，不要写「值得回顾的收藏」小节，也不要编造任何收藏内容";
}

/** Per-category counts over ALL notes (sensitive included), so totals and
 * category counts always add up; sensitive contents still never appear. */
export function categoryCounts(allNotes: NoteRow[]): { counts: Map<string, number>; sensitive: number } {
  const counts = new Map<string, number>();
  let sensitive = 0;
  for (const n of allNotes) {
    const k = n.category ?? "idea";
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (n.is_sensitive) sensitive++;
  }
  return { counts, sensitive };
}

export function fallbackMarkdown(
  weekStart: string,
  weekEnd: string,
  allNotes: NoteRow[],
  periodLabel: "week" | "month" = "week",
  agg?: { total: number; counts: Map<string, number>; sensitive: number }
): string {
  // 口径统一：敏感笔记计入总数与分类计数，但正文（标题/内容）绝不展示；
  // 传入 agg 时计数用 SQL 聚合口径（allNotes 可能被 LIMIT 截断，只用于列表展示）
  const { counts, sensitive } = agg ?? categoryCounts(allNotes);
  const total = agg?.total ?? allNotes.length;
  const byCat = new Map<string, NoteRow[]>();
  for (const n of allNotes) {
    const k = n.category ?? "idea";
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k)!.push(n);
  }
  const label = periodLabel === "month" ? "月报" : "周报";
  const unit = periodLabel === "month" ? "本月" : "本周";
  let md = `# 碎念${label}（${weekStart} ~ ${weekEnd}）\n\n${unit}共记录 ${total} 条${sensitive > 0 ? `（含 ${sensitive} 条敏感记录，仅计数不展示内容）` : ""}。\n`;
  for (const [cat, rows] of byCat) {
    md += `\n## ${CATEGORY_LABEL[cat] ?? cat}（${counts.get(cat) ?? rows.length}）\n`;
    const hidden = rows.filter((n) => n.is_sensitive).length;
    for (const n of rows.filter((n) => !n.is_sensitive)) md += `- ${execLinePrefix(n)}${escapeMdText((n.title || n.content).slice(0, 60))}\n`;
    if (hidden > 0) md += `- （另有 ${hidden} 条敏感记录，内容不展示）\n`;
  }
  return md;
}

/** 周报/月报统计数字的权威口径（SQL 聚合），供程序拼接与 LLM 叙述后校验共用。 */
export interface ReportNumbers {
  total: number;
  counts: Map<string, number>;
  sensitive: number;
  todoCreated: number;
  todoDone: number;
}

/** 概览统计句：程序拼接、不经 LLM（R221 P1-2）。 */
export function overviewStatLine(unit: string, nums: ReportNumbers): string {
  const countsLine = [...nums.counts.entries()]
    .map(([cat, n]) => `${CATEGORY_LABEL[cat] ?? cat} ${n} 条`)
    .join("、");
  return `${unit}共记录 ${nums.total} 条（${countsLine}${nums.sensitive > 0 ? `；含 ${nums.sensitive} 条敏感记录，仅计数不展示内容` : ""}）。`;
}

/** 裸 URL 在 marked 自动链接下会把紧随的中文标点/文字吸进锚文本（R221 P2-2）：
 * URL 只含可打印 ASCII，截到第一个非 ASCII 字符、剥掉尾部标点后用 <> 包裹。
 * 已有 markdown 链接（前一字符是 ( 或 <）不动。 */
export function sanitizeBareUrls(md: string): string {
  return md.replace(/(^|[^(<])(https?:\/\/[!-~]+)/g, (_m, pre: string, url: string) => {
    const trimmed = url.replace(/[)\]}>.,;:!?'"]+$/, "");
    const rest = url.slice(trimmed.length);
    return `${pre}<${trimmed}>${rest}`;
  });
}

/** LLM 叙述净化（R221 P1-2）：剥掉重复标题、删掉程序拼接负责的「待办盘点/收支合计」
 * 小节，并把叙述里与 SQL 源值冲突的计数改写为源值——模型抄错数字也到不了用户面前。 */
export function sanitizeNarrative(text: string, unit: string, nums: ReportNumbers): string {
  let t = text.trim();
  t = t.replace(/^#\s+[^\n]*\n+/, "");
  t = t.replace(/^##\s*[^\n]*概览[^\n]*\n+/, "");
  t = t
    .split(/\n(?=##\s)/)
    .filter((s) => !/^##\s*(待办盘点|收支合计)/.test(s))
    .join("\n");
  t = t.replace(/共记录\s*(\d+)\s*条/g, `共记录 ${nums.total} 条`);
  for (const [cat, n] of nums.counts) {
    const label = CATEGORY_LABEL[cat] ?? cat;
    t = t.replace(new RegExp(`${label}\\s*(\\d+)\\s*条`, "g"), `${label} ${n} 条`);
  }
  t = t.replace(/新增待办\s*(\d+)\s*条/g, `新增待办 ${nums.todoCreated} 条`);
  t = t.replace(/共完成\s*(\d+)\s*条/g, `共完成 ${nums.todoDone} 条`);
  // R266 P0：周/月报叙述同样是「笔记内容进模型后生成的文本」，且报告页把它
  // 当 markdown 渲染成 HTML（外链可点、img 会自动加载）——与 ask 答案同一口径
  // 做外链收口，笔记里植入的第三方 URL 到不了渲染层。
  return sanitizeBareUrls(scrubAnswerLinks(t.trim()));
}

/**
 * Generate & store the weekly or monthly report for one user. Returns the
 * report id. Regenerating for the same period replaces the previous report.
 */
export async function generatePeriodReport(
  env: Env,
  userId: string,
  now: Date = new Date(),
  which: "last" | "this" = "last",
  period: "week" | "month" = "week"
): Promise<{ id: string; week_start: string } | null> {
  // period boundaries and digest dates follow the user's stored timezone
  // preference (Asia/Shanghai when unset) instead of a hardcoded +8h
  const tz = await loadUserTz(env, userId).catch(() => DEFAULT_TZ);
  const offsetMs = tzOffsetMs(now, tz);
  const offsetMin = tzOffsetMinutes(now, tz);
  const tzModifier = tzSqlModifier(now, tz);
  let weekStart: string;
  let weekEnd: string;
  if (period === "month") {
    const r = which === "this" ? thisMonthRange(now, offsetMs) : lastMonthRange(now, offsetMs);
    weekStart = r.monthStart;
    weekEnd = r.monthEnd;
  } else {
    const r = which === "this" ? thisWeekRange(now, offsetMs) : lastWeekRange(now, offsetMs);
    weekStart = r.weekStart;
    weekEnd = r.weekEnd;
  }
  // notes created during [weekStart, weekEnd] in the user's local time
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL
       AND datetime(created_at, ?) >= datetime(? || ' 00:00:00')
       AND datetime(created_at, ?) <= datetime(? || ' 23:59:59')
     ORDER BY created_at ASC LIMIT ${period === "month" ? 1000 : 300}`
  )
    .bind(userId, tzModifier, weekStart, tzModifier, weekEnd)
    .all<NoteRow>();
  const notes = results ?? [];
  // no notes this week: don't store an empty "0 条" report
  if (notes.length === 0) return null;

  // 权威统计口径：SQL 聚合覆盖期段内全部笔记，LIMIT 只影响展示摘要
  const aggRows = await aggregatePeriod(env, userId, tzModifier, weekStart, weekEnd).catch((): PeriodAggRow[] => []);
  const agg = aggRows.length > 0 ? categoryCountsFromAgg(aggRows) : undefined;
  const stats = await todoStatsForWeek(env, userId, weekStart, weekEnd, notes, tzModifier).catch(
    (): TodoStats => ({ created: 0, createdDone: 0, doneInWeek: 0, openTitles: [], doneTitles: [] })
  );
  if (agg) {
    stats.created = agg.counts.get("todo") ?? 0;
    stats.createdDone = aggRows.filter((r) => r.category === "todo").reduce((s, r) => s + r.todo_done_cnt, 0);
  }
  const finance = aggRows.length > 0 ? financeStatsFromAgg(aggRows) : financeStats(notes);
  const finMd = financeSection(finance);
  const label0 = period === "month" ? "月报" : "周报";
  const unit0 = period === "month" ? "本月" : "本周";
  let md = fallbackMarkdown(weekStart, weekEnd, notes, period, agg) + todoSection(stats, unit0) + finMd;
  {
    try {
      const digest = notes
        .filter((n) => !n.is_sensitive)
        .map((n, i) => {
          const cat =
            n.category === "todo"
              ? `待办·${n.todo_done ? "已完成" : "未完成"}`
              : CATEGORY_LABEL[n.category ?? "idea"];
          const amt =
            (n.category === "expense" || n.category === "income") && typeof n.amount === "number"
              ? ` 金额=${formatAmount(n.amount, n.currency || "CNY")}`
              : "";
          // 日期按用户时区展示，与报告期段边界同口径（R107 P2-2：原始 UTC 日期错位）
          const ms = parseCreatedAt(n.created_at);
          const day = Number.isNaN(ms) ? n.created_at.slice(0, 10) : localDateOf(ms, offsetMin);
          return `${i + 1}. [${cat}]${amt} (${day}) ${execLinePrefix(n)}${(n.title || n.content).slice(0, 200)}`;
        })
        .join("\n");
      const label = label0;
      const unit = unit0;
      const prev = period === "month" ? "上个月" : "上周";
      // R221 P1-2：统计数字（总数/分类计数/待办计数/收支合计）全部程序拼接注入，
      // LLM 只写叙述；LLM 输出再经 sanitizeNarrative 后校验，抄错的数字改写回 SQL 源值
      const { counts, sensitive } = agg ?? categoryCounts(notes);
      const total = agg?.total ?? notes.length;
      const nums: ReportNumbers = { total, counts, sensitive, todoCreated: stats.created, todoDone: stats.doneInWeek };
      // 收藏小节只在期段内确有可展示的收藏时才要求（R180 P2-2）：无条件索要
      // 会让模型硬凑编造；以摘要可见（非敏感）的收藏数为准，敏感收藏无正文可挑
      const visibleCollects = notes.filter((n) => !n.is_sensitive && n.category === "collect").length;
      const collectHint = collectSectionPrompt(visibleCollects);
      const text = (
        await chatComplete(env, {
          temperature: 0.4,
          max_tokens: period === "month" ? 1600 : 1200,
          timeout_ms: 40_000,
          messages: [
            {
              role: "system",
              content: `你是「碎念」${label}助手，像一位了解用户的朋友帮 TA 复盘，绝不写成逐条罗列的流水账。根据用户${prev}（${weekStart} ~ ${weekEnd}）记录的碎片，写 markdown ${label}的叙述部分。重要：报告的一级标题、「${unit}概览」的统计句（总数与分类计数）、「待办盘点」小节、「收支合计」小节都由系统程序生成并注入，你绝对不要输出这些内容，也不要在叙述里写任何总数、分类计数、待办完成数或收支合计数字（你写的数字会被系统覆盖）。你只写：1. 开头一两段（不带标题）点出${unit}的主线（用户最花心思、反复出现的那件事）；2.「## 主要在想什么」——归纳 2-4 个主题，每个主题不是罗列条目，而是讲出想法之间的关联与演进（哪个想法从哪条碎片发展而来、哪些碎片互为支撑或彼此矛盾、和主线是什么关系）；3.「## 悬而未决」——1-3 个${unit}提出但还没有结论的问题或犹豫（引用用户自己的原话更好），温和地提醒之后回头看看；已经有结论或已完成的事（「评审通过」「方案定了」「已解决/已买/已交」这类）是已闭环事项，绝不要放进本节；若确实没有可以省略此节${collectHint}。语气亲切、简洁，用中文；全文以第二人称「你」直接对用户说话，不要出现「用户」「TA」这类第三人称称呼。财务点评要与金额规模相称：小额收支不要套用「开支不少/注意财务平衡」这类模板评语，没有值得说的就不点评。只依据提供的碎片，不要编造笔记中没有的内容。`,
            },
            { role: "user", content: digest || `（${unit}没有记录）` },
          ],
        })
      )?.trim();
      if (text) {
        const narrative = sanitizeNarrative(text, unit, nums);
        md =
          `# 碎念${label}（${weekStart} ~ ${weekEnd}）\n\n## ${unit}概览\n${overviewStatLine(unit, nums)}\n\n${narrative}\n` +
          todoSection(stats, unit) +
          finMd;
      }
    } catch {
      /* fall back to the plain summary */
    }
  }

  // R306 P0-1：出口统一危险标注 + 出口维度打点（不计敏感行：敏感行不展示正文）
  const dangerousNotes = notes.filter((n) => !n.is_sensitive && noteContainsExecutableCommand(n.content || "")).length;
  md = markExecInReport(md, dangerousNotes).md;
  await bumpGuardEvents(env, [
    ["outlet_report_requests", 1],
    ["outlet_report_exec_marked_requests", dangerousNotes > 0 ? 1 : 0],
    ["outlet_report_exec_marked_notes", dangerousNotes],
  ]).catch((err) => console.error("reports: guard_events write failed", err));

  const existing = await env.DB.prepare(
    "SELECT id FROM weekly_reports WHERE user_id = ? AND week_start = ? AND period = ?"
  )
    .bind(userId, weekStart, period)
    .first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE weekly_reports SET content_md = ?, created_at = datetime('now') WHERE id = ?")
      .bind(md, existing.id)
      .run();
    return { id: existing.id, week_start: weekStart };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO weekly_reports (id, user_id, week_start, period, content_md) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, userId, weekStart, period, md)
    .run();
  return { id, week_start: weekStart };
}

/**
 * Generate & store the weekly report for one user. Returns the report id.
 * Regenerating for the same week replaces the previous report.
 */
export function generateWeeklyReport(
  env: Env,
  userId: string,
  now: Date = new Date(),
  week: "last" | "this" = "last"
): Promise<{ id: string; week_start: string } | null> {
  return generatePeriodReport(env, userId, now, week, "week");
}

/** Monthly counterpart of generateWeeklyReport (calendar months, Asia/Shanghai). */
export function generateMonthlyReport(
  env: Env,
  userId: string,
  now: Date = new Date(),
  month: "last" | "this" = "last"
): Promise<{ id: string; week_start: string } | null> {
  return generatePeriodReport(env, userId, now, month, "month");
}

/** Weekly cron: generate reports for all users. */
export async function generateAllWeeklyReports(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
  for (const u of results ?? []) {
    try {
      await generateWeeklyReport(env, u.id);
    } catch {
      /* per-user failures shouldn't stop the sweep */
    }
  }
}

/** Monthly cron (1st of each month): generate last month's report for all users. */
export async function generateAllMonthlyReports(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
  for (const u of results ?? []) {
    try {
      await generateMonthlyReport(env, u.id);
    } catch {
      /* per-user failures shouldn't stop the sweep */
    }
  }
}
