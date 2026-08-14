import type { NoteRow } from "./types";

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

  // bare "X月" (e.g. 6月/十月): that month of the current year, or last year if in the future
  if ((m = q.match(/(?:^|[^0-9个半上这本])(\d{1,2}|[一二三四五六七八九十]{1,2})月(?:份|初|中|底)?/))) {
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

/** True when a note's created_at (UTC sql string) falls inside the range. */
export function inTimeRange(createdAt: string, range: TimeRange): boolean {
  if (range.start && createdAt < range.start) return false;
  if (range.end && createdAt >= range.end) return false;
  return true;
}

/** Cosine similarity below which a semantic-only recall hit is too weak to appear as a citation. */
export const ASK_CITATION_MIN_SCORE = 0.55;

const CITE_RE = /[\[［](\d{1,2})[\]］]/g;

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
    const cleaned = answer.replace(CITE_RE, "");
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
    answer: rewritten,
    references: keep.map((n) => ({ index: renumber.get(n)!, note_id: noteIds[n - 1] })),
  };
}

/** The model's answer amounts to "没找到" (no [n] citations backing anything). */
export function isRefusalAnswer(answer: string): boolean {
  const hasCitation = /[\[［]\d{1,2}[\]］]/.test(answer);
  return !hasCitation && /没有?找到|没有相关|没有记录|未找到|找不到|没记过|没有这方面|没有笔记/.test(answer);
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
 * Build the explicit "没找到" answer, with up to 3 nearby notes as suggestions
 * ("相近的记录" the user might have meant). Suggestions map to references so
 * the client renders them as cards.
 */
export function buildNoAnswerResponse(suggestions: Pick<NoteRow, "id" | "title" | "content">[]): {
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
  return {
    answer: `${NO_ANSWER_TEXT}以下是几条相近的记录，可能是你想找的：\n${lines.join("\n")}`,
    references: suggestions.slice(0, 3).map((n, i) => ({ index: i + 1, note_id: n.id })),
  };
}
