import type { Env, NoteRow } from "./types";
import { formatAmount, type FinanceStats } from "./reports";
import { chatComplete } from "./ai";
import { parseLedgerTable, ledgerPositiveRows, ledgerRowsMatching } from "./triage";
import {
  remoteEndpointForms,
  execDegradedTraceReason,
  scrubUnsolicitedConduct,
  dataSurfaceFullyBenign,
} from "./prompt-armor";

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
  if (s.length === 3 && s[0] in CN_NUM && s[1] === "十" && s[2] in CN_NUM) return CN_NUM[s[0]] * 10 + CN_NUM[s[2]];
  return null;
}

export interface TimeRange {
  /** inclusive lower bound, UTC "YYYY-MM-DD HH:MM:SS" */
  start: string | null;
  /** exclusive upper bound, UTC "YYYY-MM-DD HH:MM:SS" */
  end: string | null;
  /** the phrase that produced the range, for logging/debugging */
  phrase: string;
  /**
   * R298 P1-1（audit-r297 §5）：**当期**窗（今天/本周/本月/本季度/今年），上界开放
   * 但语义是「到此刻为止」。未来日期的记账（09-15 / 10-10 / 12-24 这类预记/计划）
   * 不属于当期已发生的收支——旧口径把它们并入当期，同一笔在问「9月/12月」时又
   * 各自出现一次，等于重复计入。此标记令精筛排除未来事件，并单独披露笔数。
   */
  excludeFuture?: boolean;
}

/**
 * Parse an explicit time scope out of a (rewritten) question: 今天/昨天/前天、
 * 这几天、最近N天/周/个月、本周/上周、本月/上个月、N个月前、季度（上/本/下/
 * 第N季度/QN）、上下半年、去年/今年、今年X月、X月.
 * Returns null when the question has no recognizable time phrase — recall is
 * then unrestricted. Dates use Asia/Shanghai day boundaries, output bounds are
 * the UTC strings D1 stores in created_at.
 */
export function parseTimeRange(question: string, now: Date = new Date()): TimeRange | null {
  const q = question;
  let m: RegExpMatchArray | null;

  // 裸「X月」/裸日期的年份推断与笔记事件时间同口径（audit-r293 P2-1）：
  // 未来 ≤60 天视为今年的临近月份/日期（与 noteEventDate 的补记容忍一致），
  // 更远的未来才回退到去年——消除「10月记了账却答『10月没有记账记录』」。
  const bareYear = (sh: Date, mon: number, day = 1): number => {
    if (mon - 1 <= sh.getUTCMonth()) return sh.getUTCFullYear();
    const aheadMs =
      Date.UTC(sh.getUTCFullYear(), mon - 1, day) -
      Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate());
    return aheadMs > 60 * 86400_000 ? sh.getUTCFullYear() - 1 : sh.getUTCFullYear();
  };

  // 「到今天为止/截至今天」是上界措辞，不是「今天」单日窗（audit-r295 §6 #17）。
  if (/(?<![到至截])(?:今天|今日)/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, 0)), end: null, phrase: "今天", excludeFuture: true };
  if (/昨天|昨日/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -1)), end: toUtcSql(shanghaiMidnight(now, 0)), phrase: "昨天" };
  if (/前天/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -2)), end: toUtcSql(shanghaiMidnight(now, -1)), phrase: "前天" };
  if (/这几天|最近几天|近几天/.test(q))
    return { start: toUtcSql(shanghaiMidnight(now, -6)), end: toUtcSql(now), phrase: "这几天" };

  // 最近/过去 N 天|周|个月 (rolling window ending now)
  if ((m = q.match(/(?:最近|近|过去)\s*(\d+|[一两二三四五六七八九十半]{1,2})\s*(天|日|周|星期|个?月|年)/))) {
    const n = parseNum(m[1]);
    if (n !== null) {
      const unitDays = /天|日/.test(m[2]) ? 1 : /周|星期/.test(m[2]) ? 7 : /月/.test(m[2]) ? 30 : 365;
      // 相对滚动窗以 now 为上界（audit-r293 P2-1：「最近半年」不得把未来
      // 事件时间计入）
      return { start: toUtcSql(shanghaiMidnight(now, -Math.round(n * unitDays))), end: toUtcSql(now), phrase: m[0] };
    }
  }
  if (/最近一周|最近1周/.test(q)) return { start: toUtcSql(shanghaiMidnight(now, -7)), end: toUtcSql(now), phrase: "最近一周" };

  // 本周/这周 (since Monday) and 上周 (previous Mon..Sun)
  if (/本周|这周|这一?周|本星期|这个?星期/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const dow = (sh.getUTCDay() + 6) % 7; // Monday=0
    return { start: toUtcSql(shanghaiMidnight(now, -dow)), end: null, phrase: "本周", excludeFuture: true };
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

  if (/本月|这个?月/.test(q))
    return { start: toUtcSql(shanghaiMonthStart(now, 0)), end: null, phrase: "本月", excludeFuture: true };
  if (/上个?月/.test(q))
    return { start: toUtcSql(shanghaiMonthStart(now, 1)), end: toUtcSql(shanghaiMonthStart(now, 0)), phrase: "上个月" };

  // N 个月前 / N 个多月前: a window around that time (fuzzy human memory)。
  // 必须带「个/多」——「三月之前」是日历月上界（audit-r295 §6 #8），不是模糊窗。
  if ((m = q.match(/(\d+|[一两二三四五六七八九十]{1,2})\s*(?:个多?|多)月(?:多)?(?:之|以)?前/))) {
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

  // 季度窗（R246 F-5，audit-r245）：自然季度日历窗，与月/周/年同一管道。
  // 相对问法（上/本/下季度）先于绝对问法（第N季度/QN），否则「上一季度」
  // 会被「一季度」抢走；绝对季度一律缺省当前年度（R278 P2-5，audit-r277
  // Q4→2025 bug：旧口径「未来季度取去年」把未到的本年 Q4 解到去年，
  // 用户问「今年 Q4」语义下应是当前年的空窗口，不是去年数据）。
  const quarterRange = (y: number, qi: number, phrase: string): TimeRange => ({
    start: toUtcSql(new Date(Date.UTC(y, qi * 3, 1) - SH_OFFSET_MS)),
    end: toUtcSql(new Date(Date.UTC(y, qi * 3 + 3, 1) - SH_OFFSET_MS)),
    phrase,
  });
  // 绝对年份前缀（R250 P2-1，audit-r249）：「2026年」与「今年/去年」同一
  // 管道解析，绝不平行打补丁。捕获组可能是相对词或四位年份。
  const absYear = (s: string | undefined): number | null => {
    const ym = s?.match(/((?:19|20)\d{2})\s*年/);
    return ym ? parseInt(ym[1], 10) : null;
  };
  if (/季度|[Qq][1-4]/.test(q)) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const curY = sh.getUTCFullYear();
    const curQ = Math.floor(sh.getUTCMonth() / 3);
    const rel = (offset: number, phrase: string): TimeRange => {
      const total = curQ + offset;
      return quarterRange(curY + Math.floor(total / 4), ((total % 4) + 4) % 4, phrase);
    };
    if (/上上个?季度/.test(q)) return rel(-2, "上上个季度");
    if (/上一?个?季度/.test(q)) return rel(-1, "上个季度");
    if (/下一?个?季度/.test(q)) return rel(1, "下个季度");
    if (/本季度|这个?季度|当前季度|这一?季度/.test(q)) {
      return { start: quarterRange(curY, curQ, "本季度").start, end: null, phrase: "本季度", excludeFuture: true };
    }
    if (
      (m = q.match(/(今年|去年|(?:19|20)\d{2}\s*年)?\s*(?:第\s*)?([一二三四1-4])\s*季度/)) ||
      (m = q.match(/(今年|去年|(?:19|20)\d{2}\s*年)?\s*[Qq]([1-4])/))
    ) {
      const n = parseNum(m[2]);
      if (n !== null && n >= 1 && n <= 4) {
        const qi = n - 1;
        const y = absYear(m[1]) ?? (m[1] === "去年" ? curY - 1 : curY);
        return quarterRange(y, qi, m[0].trim());
      }
    }
  }

  // 半年窗（R246 F-5）：上/下半年按日历半年；「半年前」不在此列（无上下前后
  // 前缀，由「过去半年」滚动窗与 N月前模糊窗覆盖）。
  if ((m = q.match(/(今年|去年|(?:19|20)\d{2}\s*年)?\s*([上前下后])半年/))) {
    const sh = new Date(now.getTime() + SH_OFFSET_MS);
    const firstHalf = m[2] === "上" || m[2] === "前";
    let y = absYear(m[1]) ?? (m[1] === "去年" ? sh.getUTCFullYear() - 1 : sh.getUTCFullYear());
    // 裸「下半年」在上半年问出时指去年下半年（未来窗与裸「X月」同口径，
    // 含 ±60 天临近容忍）
    if (!m[1] && !firstHalf && bareYear(sh, 7) !== sh.getUTCFullYear()) y -= 1;
    const startMon = firstHalf ? 0 : 6;
    return {
      start: toUtcSql(new Date(Date.UTC(y, startMon, 1) - SH_OFFSET_MS)),
      end: toUtcSql(new Date(Date.UTC(y, startMon + 6, 1) - SH_OFFSET_MS)),
      phrase: m[0].trim(),
    };
  }

  // 「(YYYY年)M月 到 (YYYY年)M月」月份区间（audit-r295 §6 #14：跨年区间被
  // 截断成起始月）：闭区间按日历月，缺省结束年份=起始年份（结束月更小则跨年+1）。
  if (
    (m = q.match(
      /(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份)?\s*(?:一直)?(?:到|至|~|～|—|-)\s*(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份)?(?!\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日])/
    ))
  ) {
    const mon1 = parseNum(m[2]);
    const mon2 = parseNum(m[4]);
    if (mon1 !== null && mon2 !== null && mon1 >= 1 && mon1 <= 12 && mon2 >= 1 && mon2 <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y1 = m[1] ? parseInt(m[1], 10) : bareYear(sh, mon1);
      let y2 = m[3] ? parseInt(m[3], 10) : y1;
      if (!m[3] && y2 === y1 && mon2 < mon1) y2 = y1 + 1;
      const start = new Date(Date.UTC(y1, mon1 - 1, 1) - SH_OFFSET_MS);
      const end = new Date(Date.UTC(y2, mon2, 1) - SH_OFFSET_MS);
      if (end.getTime() > start.getTime())
        return { start: toUtcSql(start), end: toUtcSql(end), phrase: `${y1}年${mon1}月至${y2}年${mon2}月` };
    }
  }

  // 「X月之前/以前」日历月上界（audit-r295 §6 #8：被当成检索关键词 + 错误
  // 模糊窗）：终点为该月 1 日零点（不含该月），起点开放；年份与裸「X月」同口径。
  if (
    (m = q.match(
      /(?:(今年|去年|(?:19|20)\d{2}\s*年)\s*)?(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份)?\s*(?:之前|以前)(?!\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日])/
    ))
  ) {
    const mon = parseNum(m[2]);
    if (mon !== null && mon >= 1 && mon <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = absYear(m[1]) ?? (m[1] === "去年" ? sh.getUTCFullYear() - 1 : m[1] === "今年" ? sh.getUTCFullYear() : bareYear(sh, mon));
      return {
        start: null,
        end: toUtcSql(new Date(Date.UTC(y, mon - 1, 1) - SH_OFFSET_MS)),
        phrase: `${y}年${mon}月之前（不含${mon}月）`,
      };
    }
  }

  // 「今年X月/去年X月」（R246 F-6，audit-r245）：必须先于宽泛「今年/去年」
  // 分支，否则被整年窗吞掉、不按具体月份窗执行。
  // 「今年8月10号」带具体日，不在本分支收口（负向前瞻只拒「N号/日」
  // 真正的日期后缀，「今年8月一共花了多少」的「一」不能误拒）。
  if (
    (m = q.match(
      /(今年|去年|(?:19|20)\d{2}\s*年)\s*(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底)?(?!\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日])/
    ))
  ) {
    const n = parseNum(m[2]);
    if (n !== null && n >= 1 && n <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = absYear(m[1]) ?? (m[1] === "去年" ? sh.getUTCFullYear() - 1 : sh.getUTCFullYear());
      return {
        start: toUtcSql(new Date(Date.UTC(y, n - 1, 1) - SH_OFFSET_MS)),
        end: toUtcSql(new Date(Date.UTC(y, n, 1) - SH_OFFSET_MS)),
        phrase: m[0].trim(),
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
    // 「今年到目前为止/至今/不要算未来」上界压到 now（audit-r295 §6 #15/#17：
    // 自然年开放窗把未来事件时间计入）。
    const capped = /[到至截]\s*(?:目前|今天|今日|现在)|至今|为止|不(?:要|用|想)?(?:计|算)\s*未来|别算未来/.test(q);
    return {
      start: toUtcSql(new Date(Date.UTC(sh.getUTCFullYear(), 0, 1) - SH_OFFSET_MS)),
      end: capped ? toUtcSql(now) : null,
      phrase: capped ? "今年至今" : "今年",
      ...(capped ? {} : { excludeFuture: true }),
    };
  }

  // 裸「YYYY年」整年窗（R250 P2-1）：后面紧跟月/季度/半年时不在此收口
  //（上面各分支已带年处理），跟「初/中/底」的模糊问法保持 fail-closed。
  if (
    (m = q.match(
      /(?:^|[^0-9])((?:19|20)\d{2})\s*年(?!\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月|\s*(?:第\s*)?[一二三四1-4]\s*季度|\s*[Qq][1-4]|\s*[上前下后]半年|[初中底])/
    ))
  ) {
    const y = parseInt(m[1], 10);
    return {
      start: toUtcSql(new Date(Date.UTC(y, 0, 1) - SH_OFFSET_MS)),
      end: toUtcSql(new Date(Date.UTC(y + 1, 0, 1) - SH_OFFSET_MS)),
      phrase: `${y}年`,
    };
  }

  // 「M月D日之前/以前」（R290 P1，audit-r289 §财务时间窗：「3 月 10 日之前一共花了
  // 多少钱」被解成当天单日窗）：终点为该日零点（不含当日）、起点开放；
  // 年份与裸「X月」同口径（未来月份取去年）。
  if (
    (m = q.match(
      /(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]\s*(?:之前|以前)/
    ))
  ) {
    const yAbs = m[1] ? parseInt(m[1], 10) : null;
    const mon = parseNum(m[2]);
    const day = parseNum(m[3]);
    if (mon !== null && day !== null && mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = yAbs ?? bareYear(sh, mon, day);
      return {
        start: null,
        end: toUtcSql(new Date(Date.UTC(y, mon - 1, day) - SH_OFFSET_MS)),
        phrase: `${yAbs === null ? `${y}年` : ""}${m[0].trim()}（不含当日）`,
      };
    }
  }

  // 「M月D日之后/以后/以来/起」：起点为该日零点（含当日）、终点开放。
  if (
    (m = q.match(
      /(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]\s*(?:之后|以后|以来|起)/
    ))
  ) {
    const yAbs = m[1] ? parseInt(m[1], 10) : null;
    const mon = parseNum(m[2]);
    const day = parseNum(m[3]);
    if (mon !== null && day !== null && mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = yAbs ?? bareYear(sh, mon, day);
      return {
        start: toUtcSql(new Date(Date.UTC(y, mon - 1, day) - SH_OFFSET_MS)),
        end: null,
        phrase: `${yAbs === null ? `${y}年` : ""}${m[0].trim()}（含当日）`,
      };
    }
  }

  // 「M月上/中/下旬」（R290 P1）：上旬 1–10、中旬 11–20、下旬 21–月末；
  // 年份与裸「X月」同口径。
  if (
    (m = q.match(
      /(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月\s*(上|中|下)旬/
    ))
  ) {
    const yAbs = m[1] ? parseInt(m[1], 10) : null;
    const mon = parseNum(m[2]);
    if (mon !== null && mon >= 1 && mon <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = yAbs ?? bareYear(sh, mon);
      const dq = m[3];
      const start = dq === "上" ? 1 : dq === "中" ? 11 : 21;
      const end =
        dq === "上"
          ? new Date(Date.UTC(y, mon - 1, 11) - SH_OFFSET_MS)
          : dq === "中"
            ? new Date(Date.UTC(y, mon - 1, 21) - SH_OFFSET_MS)
            : new Date(Date.UTC(y, mon, 1) - SH_OFFSET_MS);
      return {
        start: toUtcSql(new Date(Date.UTC(y, mon - 1, start) - SH_OFFSET_MS)),
        end: toUtcSql(end),
        phrase: m[0].trim(),
      };
    }
  }

  // 明确日期与日期区间（R236 P3-4，audit-r235 §6：「8月10号到8月20号之间买咖啡豆
  // 花了多少」时间窗问法落空）：「M月D号」「M月D号到(M月)D号(之间)」确定性
  // 解析成上海日界的闭开区间；年份与裸「X月」同口径（未来月份取去年）。
  if (
    (m = q.match(
      /(?:((?:19|20)\d{2})\s*年\s*)?(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日](?:\s*(?:到|至|~|～|—|-|一直到)\s*(?:(\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*)?(\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日])?/
    ))
  ) {
    const yAbs = m[1] ? parseInt(m[1], 10) : null;
    const mon1 = parseNum(m[2]);
    const day1 = parseNum(m[3]);
    const mon2 = m[4] ? parseNum(m[4]) : mon1;
    const day2 = m[5] ? parseNum(m[5]) : null;
    if (
      mon1 !== null && day1 !== null && mon2 !== null &&
      mon1 >= 1 && mon1 <= 12 && mon2 >= 1 && mon2 <= 12 &&
      day1 >= 1 && day1 <= 31 && (day2 === null || (day2 >= 1 && day2 <= 31))
    ) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      // 具体到「M月D号」的问法多指最近一次该日期：未来 ≤60 天视为今年的
      // 临近计划（如车票/预约），更远的未来月份才回退到去年（audit-r271 P1-6 q27）
      let y = yAbs ?? sh.getUTCFullYear();
      if (yAbs === null && mon1 - 1 > sh.getUTCMonth()) {
        const aheadMs = Date.UTC(sh.getUTCFullYear(), mon1 - 1, day1) - Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate());
        if (aheadMs > 60 * 24 * 3600 * 1000) y = sh.getUTCFullYear() - 1;
      }
      const start = new Date(Date.UTC(y, mon1 - 1, day1) - SH_OFFSET_MS);
      const end =
        day2 !== null
          ? new Date(Date.UTC(y, mon2 - 1, day2 + 1) - SH_OFFSET_MS)
          : new Date(Date.UTC(y, mon1 - 1, day1 + 1) - SH_OFFSET_MS);
      if (end.getTime() > start.getTime()) {
        return { start: toUtcSql(start), end: toUtcSql(end), phrase: m[0].trim() };
      }
    }
  }

  // 「X月到现在/至今/以来」（audit-r247 F-3）：起点为该月月初、终点开放，
  // 年份与裸「X月」同口径（未来月份取去年）。
  if (
    (m = q.match(
      /(?:^|[^0-9个半上这本])((\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底)?\s*(?:(?:一直)?[到至]\s*(?:现在|今天|目前(?:为止)?)|以来))/
    ))
  ) {
    const n = parseNum(m[2]);
    if (n !== null && n >= 1 && n <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = bareYear(sh, n);
      return {
        start: toUtcSql(new Date(Date.UTC(y, n - 1, 1) - SH_OFFSET_MS)),
        end: null,
        phrase: `${y}年${m[1].trim()}`,
      };
    }
  }

  // bare "X月" (e.g. 6月/十月/"7 月"): that month of the current year, or last year if in the future
  if ((m = q.match(/(?:^|[^0-9个半上这本])(\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底)?/))) {
    const n = parseNum(m[1]);
    if (n !== null && n >= 1 && n <= 12) {
      const sh = new Date(now.getTime() + SH_OFFSET_MS);
      const y = bareYear(sh, n);
      // 裸「X月」显式回写生效年份（audit-r295 §6 #4/#5：静默回退去年，与
      // 「去年12月」输出一字不差，用户无法分辨）。
      return {
        start: toUtcSql(new Date(Date.UTC(y, n - 1, 1) - SH_OFFSET_MS)),
        end: toUtcSql(new Date(Date.UTC(y, n, 1) - SH_OFFSET_MS)),
        phrase: `${y}年${m[0].trim()}`,
      };
    }
  }
  return null;
}

// ---- 财务聚合问答（R107 P1-2）----
// 「X 时间一共花了多少钱」类合计问题必须走 SQL 精确聚合（与周报/月报同一
// financeStats 口径），绝不能靠 LLM 对被 LIMIT 截断的召回片段心算。

export const FINANCE_WORD_RE = /花了?|花销|花费|支出|开支|消费|开销|收入|进账|入账|结余|净剩|收支|余额|记了?账|账单|赚了?|挣了?|用掉|缴费|交费|收款|[收拿][到了](?=[^？?。]{0,6}[钱款])|到手(?=[^？?。]{0,6}[钱款])|[缴交用]了?(?=[^？?。]{0,10}(?:多少|几))/;
// 「余额宝」是产品名不是聚合措辞（R264 P3-1，audit-r263：「从余额宝转出的
// 500 算收入吗」被「余额」误判成 fail_closed 全账合计）
const AGG_WORD_RE = /一共|总共|合计|总计|共计|加起来|多少钱|多少笔|几笔|平均每|总额|结余|净剩|收支|余额(?!宝)|多少|怎么样|怎样|如何|情况/;
// sum-style wording that only makes sense as a books-level aggregate: when it
// appears with a finance word but the question can't be routed to the exact
// aggregate (extra qualifiers remain), the LLM must NOT mental-math it.
const STRONG_AGG_RE = /一共|总共|合计|总计|共计|加起来|平均每|总额|结余|净剩|收支|余额(?!宝)/;
// strip time phrases / finance verbs / aggregation words / filler; whatever
// meaningful text remains means the question is about a specific item
// ("买咖啡花了多少钱"), not an overall aggregate — fall through to normal ask.
const STRIP_RES: RegExp[] = [
  /(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日](?:\s*(?:到|至|~|～|—|-|一直到)\s*(?:(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*月\s*)?(?:\d{1,2}|[一二三四五六七八九十]{1,3})\s*[号日])?(?:之间|期间|以内|之内|前后|左右|之前|以前|之后|以后)?|今天|今日|昨天|昨日|前天|这几天|最近几天|近几天|(?:最近|近|过去)\s*(?:\d+|[一两二三四五六七八九十半]{1,2})\s*(?:天|日|周|星期|个?月|年)|本周|这一?周|这周|本星期|这个?星期|上一?周|上个?星期|上周|本月|这个?月|上个?月|(?:今年|去年)?\s*(?:上上个?|上一?个?|下一?个?|本|这一?个?|当前)季度|(?:今年|去年)?\s*第?\s*[一二三四1-4]\s*季度|[Qq][1-4]|(?:今年|去年)?\s*[上前下后]半年|(?:今年|去年|(?:19|20)\d{2}\s*年)?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份)?\s*(?:一直)?(?:到|至|~|～|—|-)\s*(?:今年|去年|(?:19|20)\d{2}\s*年)?\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份)?|(?:今年|去年)\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底|\s*[上中下]旬)?(?:之前|以前)?|去年|今年|(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月(?:份|初|中|底|\s*[上中下]旬)?(?:之前|以前)?|(?:一直)?[到至]\s*(?:现在|今天|目前)(?:为止)?|至今|为止|以来|不(?:要|用|想)?(?:计|算)\s*未来的?|别算未来的?|(?:19|20)\d{2}\s*年/g,
  /一共|总共|合计|总计|共计|加起来|平均每天|平均|多少钱|多少笔|几笔|多少|总额|怎么样|怎样|如何|情况/g,
  /总?(?:花销|花费|支出|开支|消费|开销|收入|进账|入账|结余|净剩|收支|余额)|(?:工资|薪水)(?:到账|发了?)之?后|花了?|记了?账|账单|赚了?|挣了?|用掉|还了|还款|收款|[收拿][到了]|到手|[缴交用]了?/g,
  /请问|大概|大约|一下|来着|帮我算|算算|统计|我的?|？|\?|，|,|。|、|\s/g,
];

// 单字语气/停用字（R240 P2-1，audit-r239 §4.2 根因）：「了/吗/都/在/有…」
// 这类单字绝不能全局删除——它们大量出现在实词内部（成都/了解/有道/在行/
// 和平），全局剥离会把「成都出差」剥成「成出差」，LIKE 注入零命中后
// fail-closed 拒答。安全口径：先把可整词剥离的措辞替换成边界标记，单字
// 语气字只在「独立成段」（两侧都是边界/已剥离标记）时才删除，嵌在实词
// 内（任一侧贴着保留文字）一律保留。
const FILLER_CHAR_CLASS = "了过吗呢啊呀哦嘛吧是都在有和与的记写存发条篇个样件事钱";
const STRIP_MARKER = "\u0001";
// 连接词切分只在「夹在两个实词字中间」时生效（R240 P2-1：「和平精英」开头
// 的「和」不是连接词，无条件切会切成「平精英」）
const TOPIC_CONNECTIVE_SPLIT_RE = /(?<=[\u4e00-\u9fa5A-Za-z0-9])(?:和|与|跟|以及|、)(?=[\u4e00-\u9fa5A-Za-z0-9])/;
const TOPIC_CONNECTIVE_SPLIT_EX_RE = /(?<=[\u4e00-\u9fa5A-Za-z0-9])(?:和|与|跟|以及|、|的)(?=[\u4e00-\u9fa5A-Za-z0-9])/;
const FILLER_SOLO_RE = new RegExp(`(?<=^|${STRIP_MARKER})[${FILLER_CHAR_CLASS}]+(?=$|${STRIP_MARKER})`, "g");

/** 逐条剥离（整词措辞→边界标记），再删仅独立成段的单字语气字，最后清标记。 */
function applyStrips(text: string, res: RegExp[]): string {
  let out = text;
  for (const re of res) out = out.replace(re, STRIP_MARKER);
  out = out.replace(FILLER_SOLO_RE, "");
  return out.replace(new RegExp(`${STRIP_MARKER}+`, "g"), "");
}

// 复合名词保护（R234 P3-3，audit-r233 §P3-3：「信用卡还了多少钱」被逐字
// 剥成「信卡还」注入 LIKE 必零命中）：含财务动词字的常见复合名词先占位
// 保护、剥离后还原，避免词中字被当作动词剥掉。
// 「余额宝」是产品名（R268，audit-r267 §2.2：「从余额宝转出」被剥成
// 「从宝转出」注入 LIKE 必零命中），与「余额」聚合词同形，先占位保护。
const PROTECTED_COMPOUND_RE = /信用卡|花呗|余额宝|零钱通|日用品|公交|交通|住宿/g;

/** 剥离财务/聚合/时间措辞（STRIP_RES），复合名词占位保护后再剥。 */
function stripFinanceWording(text: string): string {
  const kept: string[] = [];
  let out = text.replace(PROTECTED_COMPOUND_RE, (m) => {
    kept.push(m);
    return String.fromCharCode(0xe000 + kept.length - 1);
  });
  out = applyStrips(out, STRIP_RES);
  return out.replace(/[\ue000-\ue0ff]/g, (ch) => kept[ch.charCodeAt(0) - 0xe000] ?? "");
}

// 名词式账目问法（「X月的支出」「今年到今天为止的支出」）：没有「一共/多少」
// 等聚合措辞，但剥掉时间与财务措辞后一无所剩，问的就是账本级合计
//（audit-r295 §6 #13/#17：这类问法漂移到 AI 路径，路由不稳且会答错）。
const FINANCE_NOUN_RE = /支出|收支|开支|开销|花销|花费|消费|收入|进账|结余/;

/** True when the question asks for an overall finance aggregate (not a specific item's price). */
export function isFinanceAggQuestion(question: string): boolean {
  if (!FINANCE_WORD_RE.test(question)) return false;
  if (!AGG_WORD_RE.test(question) && !FINANCE_NOUN_RE.test(question)) return false;
  return stripFinanceWording(question).length < 2;
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
const FACT_QUERY_RE = /叫什么|是什么|什么名|名字|哪几?[本个件家部条]|哪些|哪里|哪儿|分别|各是|什么时候|在哪|为什么|依据/;

// 并列疑问框架（R256 P2-1，audit-r255：「本月支出和收入分别多少」被 FACT_QUERY
// 的「分别」拦下落普通召回，答成与事实相反的空答）：紧跟合计措辞的「分别/
// 各自」是疑问框架不是事实检索，聚合意图判定前先归一化掉——与
// financeTopicTerms 同一口径（R250 P2-3）。
const PARALLEL_AGG_FRAME_RE = /(?:各自|分别|各)(?=各?(?:花|用|要|是?多少|一共|总共|合计))/g;

export function financeAggIntent(question: string): "exact" | "fail_closed" | null {
  // 「它花了多少钱」问的是某个具体事物的价格，不是全账聚合：代词剥词后残留
  // 不足 2 字会被误判成 exact（R186 P1 根因），指代问法一律走普通召回。
  if (ASK_PRONOUN_REF_RE.test(question)) return null;
  question = question.replace(PARALLEL_AGG_FRAME_RE, "");
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

// ---- 财务双窗对比（R256 P2-2，audit-r255）----
// 「今年上半年和下半年到现在，哪段花得多」这类任意双时间窗对比不在环比
// （本月vs上月/本周vs上周）覆盖内，此前落普通召回答出与事实相反的空答。
// 与环比同一架构：两窗各自 SQL 精确聚合后走 buildFinanceMomAnswer 确定性对比。
// 「3月和4月分别花了多少」是双窗并列问法（R262 P2-2，audit-r261：不在比较
// 词表内时退化为单窗且静默丢半个问题）：并列疑问框架与比较同一双窗管道，
// 答案本就并列给出两窗金额与差额。
const DUAL_WINDOW_COMPARE_RE =
  /哪段|哪个时间段|哪个时期|哪半年|哪个季度|哪个月份?|[花支][得的出]了?(?:更)?[多少]|开销(?:更)?大|支出(?:更)?[多高]|还是|(?:分别|各自?)[^？?。]{0,8}(?:多少|几笔)/;

/** 识别财务双时间窗对比问题，返回两个窗口；非此类返回 null。 */
export function financeDualWindowIntent(question: string, now: Date = new Date()): { a: TimeRange; b: TimeRange } | null {
  if (!FINANCE_WORD_RE.test(question)) return null;
  if (!DUAL_WINDOW_COMPARE_RE.test(question)) return null;
  const parts = question
    .split(/和|与|跟|还是|、|，|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  const ranges: TimeRange[] = [];
  for (const p of parts) {
    const r = parseTimeRange(p, now);
    if (r) ranges.push(r);
    if (ranges.length === 2) break;
  }
  if (ranges.length !== 2) return null;
  // 两窗必须是不同的时间段（「上半年和上半年」没有对比意义）
  if (ranges[0].start === ranges[1].start && ranges[0].end === ranges[1].end) return null;
  return { a: ranges[0], b: ranges[1] };
}

// R258 P2-1（audit-r257）：双窗对比吞主题限定（「3月和4月哪个月买书花得多」
// 对比的是全月总支出）。主题词与时间窗是正交限定维度：剥掉对比疑问框架词
// 后走财务子集同一套主题词剥离流水线（subsetTopicExtract），无主题时返回
// null、行为与既有纯时间窗对比完全一致。
const DUAL_WINDOW_FRAME_STRIP_RE =
  /哪段|哪个时间段|哪个时期|哪半年|哪个季度|哪个月份?|哪一?[年月周天]|还是|相比(?:之下)?|[花支][得的出]了?(?:更)?(?:多少|[多少])|开销(?:更)?大|支出(?:更)?[多高]|[赚挣][得的]了?(?:更)?(?:多少|[多少])|更[多少]|分别|各自?|[花支][了出]了?多少|几笔/g;

/** 双窗对比问法里的主题限定词（「哪个月买书花得多」→ [买书]）；无主题返回 null。 */
export function financeDualWindowTopicTerms(question: string): string[] | null {
  return subsetTopicExtract(question.replace(DUAL_WINDOW_FRAME_STRIP_RE, ""));
}

/**
 * 口径说明小字（R294 P2-2，audit-r293 §9.2）：只在口径可能有歧义时出现
 * （带时间窗/关键词限定），且只给一句短话；同时披露「之前不含当日 /
 * 以后含当日」的边界口径（P2-2）。无限定时不再逐答复读报表式免责声明。
 */
export function financeCaliberNote(phrase: string | null | undefined, keyword = false): string {
  const parts: string[] = [];
  if (keyword) parts.push("关键词匹配口径");
  if (phrase) {
    parts.push("时间按正文事件时间（无日期按记录时间）");
    if (/之前|以前/.test(phrase)) parts.push("「之前」不含当日");
    if (/之后|以后|以来|起/.test(phrase)) parts.push("「以后」含当日");
  }
  // 无时间短语的全量聚合同样明示口径对齐：同一份数据在 Ask 与周报/月报两条
  // 路径必须可对账（audit-r303 §10 q60/q66/q94），只是不附时间划定细则。
  if (parts.length === 0) return "\n\n（口径与周报/月报一致。）";
  return `\n\n（口径与周报/月报一致；${parts.join("；")}。）`;
}

/** 收支比较的确定性答案：按币种分别比较（不同币种金额不可直接比较）。 */
export function buildFinanceCompareAnswer(stats: FinanceStats, phrase: string | null): string {
  const scope = phrase ?? "全部笔记";
  if (stats.expenseCount === 0 && stats.incomeCount === 0) {
    const transferNote = stats.transferCount > 0 ? `另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支。` : "";
    return `${scope}没有记账记录（支出/收入均为 0 笔），无法比较收支。${transferNote}${financeCaliberNote(phrase)}`;
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
  md += financeCaliberNote(phrase);
  return md;
}

/** 环比比较的确定性答案：本期与上期各自精确聚合后按币种对比。 */
export function buildFinanceMomAnswer(
  cur: FinanceStats,
  prev: FinanceStats,
  curPhrase: string,
  prevPhrase: string,
  topic: string[] | null = null
): string {
  // 主题限定的双窗对比（R258 P2-1）：答案口径必须回显关键词，绝不把主题
  // 对比冒充全账对比
  const kwHead = topic ? `按关键词「${topic.join("、")}」精确匹配（标题/正文/标签），` : "";
  const noCur = cur.expenseCount === 0 && cur.incomeCount === 0;
  const noPrev = prev.expenseCount === 0 && prev.incomeCount === 0;
  if (noCur && noPrev) {
    return `${kwHead}${curPhrase}和${prevPhrase}都没有${topic ? "匹配的" : ""}记账记录，无法对比。${financeCaliberNote(curPhrase, !!topic)}`;
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
  let md = `${kwHead}${curPhrase}与${prevPhrase}对比（按币种分别比较，不同币种金额不可直接比较）：\n${lines.join("\n")}\n${curPhrase}共 ${cur.expenseCount} 笔支出、${cur.incomeCount} 笔收入；${prevPhrase}共 ${prev.expenseCount} 笔支出、${prev.incomeCount} 笔收入。`;
  const unknown = cur.unknownAmount + prev.unknownAmount;
  if (unknown > 0) md += `\n（另有 ${unknown} 笔未识别出金额，未计入对比。）`;
  md += financeCaliberNote(curPhrase, !!topic);
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
  // 单字量词/动词（条/篇/个/件/事、记/写/存/发）同属词内易伤字（日记/文件/
  // 同事），交 applyStrips 独立成段判定；多字词照常整词剥（R240 P2-1）
  /笔记|记录|东西|内容|事情/g,
  /收藏|保存/g,
  // 单字语气字（了/过/吗/都/在/有…）交 applyStrips 的独立成段判定，不在此全局剥（R240 P2-1）
  /请问|一下|来着|帮我数|数数|统计|我的?|？|\?|，|,|。|、|\s/g,
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
  const residual = applyStrips(question, [...COUNT_STRIP_RES, ...COUNT_QUALIFIER_STRIP_RES]);
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
  /** Top-N 条数（R236 P2-3，audit-r235 §6：「支出最多的三笔」落 LLM 对截断
   * 召回猜排序致完全错序）：从 rank 名起连取 count 条，与单极值/序数同一
   * ORDER BY amount 确定性管道；缺省 1 即原单极值行为。 */
  count?: number;
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

// Top-N 条数措辞（R236 P2-3）：「最多的三笔」「前三笔/前三名」「top3」——与序数
// 同属 ORDER BY amount 的确定性查询（取前 N 名），绝不交 LLM 猜排序。
// 「一笔」是单极值量词不是 Top-1 列表，不在此收口。
const TOPN_RE =
  /(?:最[贵大多高狠]|最便宜|最[小低少]|花得?最[多少]|花钱最[狠多猛]|金额最[大高小低]|数额最[大小])的?\s*(?:前)?\s*([2-9]|\d{2}|[两二三四五六七八九十]{1,2})\s*[笔项条个名]|前\s*([2-9]|\d{2}|[两二三四五六七八九十]{1,2})\s*[笔项条名大]|top\s*([2-9]\d?)/i;

/** 解析 Top-N 条数措辞；非 Top-N 问法（含单极值「一笔」）返回 null。 */
function financeTopN(question: string): number | null {
  const m = question.match(TOPN_RE);
  if (!m) return null;
  const n = parseNum(m[1] ?? m[2] ?? m[3]);
  return n !== null && Number.isInteger(n) && n >= 2 && n <= 50 ? n : null;
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
  const priceInherent = /最贵|最便宜|花得?最[多少]|花钱最[狠多猛]|金额最[大高小低]|数额最[大小]|(?:支出|消费|开销|花销|花费|开支|收入|进账|入账)最[多大高少小低]/.test(question) || /(倒数)?第[ \t]*([0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(贵|便宜)/.test(question) || Boolean(sortM);
  if (!priceInherent && !FINANCE_WORD_RE.test(question) && !/买|多少钱|花费|费用/.test(question)) return null;
  const direction: "expense" | "income" = /收入|进账|入账|赚|挣/.test(question) ? "income" : "expense";
  const premise = financeExtremePremise(question);
  const p = premise ? { premise } : {};
  // Top-N（R236 P2-3）：「支出最多的三笔」「最贵的前 5 笔」与单极值同一
  // 确定性管道，从第 1 名起连取 N 条；必须在序数判定之前（「前三笔」无
  // 「第」字不会被序数误收，但顺序上优先收 Top-N 更稳健）
  // Top-N 收口不要求 priceInherent（R240 P2-2，audit-r239 §4.3 根因）：「top 2
  // 的支出分别是多少」无「最X」措辞，priceInherent 闸门把它拦在确定性管道外
  // 落 LLM 对截断召回猜排序；配上财务词（支出/消费…）的 top N 已是明确的
  // 金额排序问法，与「支出最大的 N 笔」同一 ORDER BY amount 管道。
  const topN = financeTopN(question);
  if (topN !== null && (priceInherent || FINANCE_WORD_RE.test(question))) {
    const kind: "max" | "min" =
      /最便宜|最[小低少]|花得?最少|(?:支出|消费|开销|花销|花费|开支|收入|进账|入账)最[少小低]/.test(question) || (sortM?.[1] && /[低小]/.test(sortM[1]) && !/最[贵大多高狠]/.test(question))
        ? "min"
        : "max";
    return { kind, direction, rank: 1, count: topN, ...p };
  }
  const ord = financeOrdinal(question, sortM ? (sortM[1] && /[低小]/.test(sortM[1]) ? "min" : "max") : null);
  if (ord) return { kind: ord.kind, direction, rank: ord.rank, ...(ord.reversedAdj ? { reversedAdj: ord.reversedAdj } : {}), ...p };
  // 「最大收入/最小支出」这类极值词直接修饰财务名词（无「一笔」）同样是
  // 单笔极值问法（R202：「本月最大收入是 4500 元吗」漏判落 RAG 自相矛盾）
  if (/最贵|最高|最大的?一?[笔项]|最[大高]的?(?:收入|进账|入账|支出|消费|开销|花销|花费)|(?:支出|消费|开销|花销|花费|开支|收入|进账|入账)最[多大高]|金额最[大高]|花得?最多|花钱最[狠多猛]|最狠的?一[笔次]|数额最大/.test(question)) return { kind: "max", direction, rank: 1, ...p };
  if (/最便宜|最低|最小的?一?[笔项]|最[小低]的?(?:收入|进账|入账|支出|消费|开销|花销|花费)|(?:支出|消费|开销|花销|花费|开支|收入|进账|入账)最[少小低]|金额最[小低]|花得?最少|数额最小/.test(question)) return { kind: "min", direction, rank: 1, ...p };
  return null;
}

// 极值问法的主题限定（R174 P1）：「我买过的键盘里最贵的是哪一把」的「键盘」
// 必须注入 SQL WHERE（与财务子集/主题枚举同一 LIKE 匹配家族），绝不能识别出
// 极值意图后丢掉主题限定答成全局极值（R173 实测 3/3 复现）。剥掉极值措辞/
// 财务词/时间短语/购买动词/量词填充后，残留的干净词即主题限定词。
const EXTREME_STRIP_RES: RegExp[] = [
  STRIP_RES[0], // 时间短语，与财务聚合同一口径
  // 裸「最近/近期」是无窗口的时间副词不是主题（R228，audit-r227 P3-2：
  // 「最近第二贵的支出」的「最近」残留进 WHERE LIKE 致零命中自我否证）
  /最近|近来|近期|这段时间|这阵子/g,
  /最贵|最便宜|金额最[大高小低]|最[高低]|最大的?一?[笔项个]|最小的?一?[笔项个]|花得?最[多少]|花钱最[狠多猛]|最狠的?一[笔次]|数额最[大小]|(?:倒数)?排(?:名|行)?(?:倒数)?第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠)?|倒数第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠)?|第[ \t]*(?:[0-9]+|[一二两三四五六七八九十]{1,2})[ \t]*(?:贵|便宜|高|低|大|小|多|少|狠|名)/g,
  // 「单笔最贵」的「单笔」是计量口径词、「按金额排」的「按…排」是排序指令词，
  // 都不是主题限定（R190 P1-1：残渣注入 WHERE 让确定性路线自己否证自己）
  // Top-N 条数措辞（R236 P2-3）：「最多的三笔/前三笔/top3」是取数指令不是主题
  /最[多少]|前\s*(?:[0-9]{1,2}|[两二三四五六七八九十]{1,2})\s*[笔项条名大个]|(?:[0-9]{1,2}|[两二三四五六七八九十]{1,2})\s*[笔项条]|top\s*[0-9]{1,2}/gi,
  /单笔|每笔|逐笔|单[次项]|按(?:金额|价格|价钱|数额)?(?:从?[高低大小]到[高低大小])?排(?:序|名|行|列)?/g,
  /金额|数额/g, // 「金额倒数第二」的「金额」是排名量纲词不是主题限定
  /(?:是)?哪一?[笔项个把只台件本条张部次辆双瓶副架块支款]?|什么|多少钱|多少|分别|各自/g,
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
const EXTREME_FUNCTIONAL_RESIDUE_RE = /^[单每逐笔项次个把按排序名行列第倒数最高低大小多少贵狠便宜是否为的来源前条]+$/;

// 金额 token 不是主题词（R200，audit-r199 P2-1）：「最贵的一笔支出是 400 元吗」
// 的「400元」注入 WHERE 会让确定性路线自己否证自己（正文「学费 400」不含
// 「400元」字样 → 零命中 →「没找到」）。小数形态因「.」不在主题词字符集里
// 本就被滤掉，整数与带币种词形态在此统一剥除；孤立纯数字残渣同样不是主题。
const AMOUNT_TOKEN_RE = /\d+(?:\.\d+)?\s*(?:元|块钱?|人民币|美元|美金|日元|欧元|英镑|港[币元]|韩元|rmb|cny|usd|jpy|eur|gbp|hkd|krw)/gi;
const PURE_NUMBER_RE = /^\d+(?:\.\d+)?$/;

/** 从财务极值问法中提取主题限定词（「键盘里最贵的」→「键盘」）；无限定返回 null。 */
export function financeExtremeTopicTerms(question: string): string[] | null {
  if (!financeExtremeIntent(question)) return null;
  let residual = applyStrips(question.replace(AMOUNT_TOKEN_RE, ""), EXTREME_STRIP_RES);
  // 首尾的「的」与尾部判断词/助词（「东西是」的「是」）是剥词残渣不是主题
  residual = residual.replace(/^的+|[的是了吗呢啊呀哦嘛吧]+$/g, "");
  // 开头的介词/购买动词（「在成都…」→「成都」）与财务子集同口径
  const exStripped = residual.replace(/^[买在去为给]{1,2}/, "");
  if (exStripped.length >= 2) residual = exStripped;
  const terms = residual
    .split(TOPIC_CONNECTIVE_SPLIT_EX_RE)
    .map((s) => s.trim().replace(/[里中]$/, ""))
    .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) && !TOPIC_ENUM_GENERIC_RE.test(s) && !EXTREME_FUNCTIONAL_RESIDUE_RE.test(s) && !PURE_NUMBER_RE.test(s));
  return terms.length > 0 && terms.length <= 3 ? terms : null;
}

/** 台账聚合笔记判定（R180 P2-1）：多行台账笔记的金额是 fixLedgerAmount 锁定的
 * 列合计（R178），不是一笔消费——极值比较把它当单笔会冒充「最便宜的一把」。
 * 复用 parseLedgerTable 同一确定性解析器：内容解析出多行台账且笔记金额等于
 * 该合计时判为聚合笔记（用户手改过金额则金额已非合计，照常参与比较）。
 * 例外（R228）：只有 1 行正数明细的「付款+退款」净额句（「付款 34.5 其中
 * 退款 9」）是同一笔交易的价款冲减，净额就是单笔实付，照常参与比较。 */
export function isLedgerAggregateNote(n: Pick<NoteRow, "content" | "amount">): boolean {
  if (typeof n.amount !== "number" || !Number.isFinite(n.amount)) return false;
  const ledger = parseLedgerTable(n.content);
  return ledger !== null && Math.abs(n.amount - ledger.amount) < 0.005 && ledgerPositiveRows(n.content) >= 2;
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
  const count = query.count ?? 1;
  const kindLabel =
    count > 1
      ? `金额${query.kind === "max" ? "最大" : "最小"}的 ${count} 笔`
      : rank === 1
        ? query.kind === "max"
          ? "金额最大"
          : "金额最小"
        : `金额第 ${rank} ${query.kind === "max" ? "大" : "小"}`;
  const ledgerNote = ledgerExcluded > 0 ? `另有 ${ledgerExcluded} 条多行台账笔记的金额为多笔合计，未参与单笔比较` : "";
  const shortNote =
    shortCurrencies.length > 0
      ? count > 1
        ? `币种 ${shortCurrencies.map((s) => `${s.currency} 已识别金额的单笔${label}仅 ${s.count} 笔`).join("、")}，不足 ${count} 笔，按实有条数列出`
        : `币种 ${shortCurrencies.map((s) => `${s.currency} 已识别金额的单笔${label}仅 ${s.count} 笔`).join("、")}，不存在第 ${rank} 名`
      : "";
  if (rows.length === 0) {
    // 时间口径明示（R202，audit-r201 P3-3）：带时间短语却零命中时，说明范围
    // 按记录时间划定——「本月最大收入」查不到正文写「三月」的当月新笔记时，
    // 用户能看出口径差异而不是以为数据丢了
    const extras = [
      shortNote,
      ledgerNote,
      unknownAmount > 0 ? `另有 ${unknownAmount} 笔${label}未识别出金额` : "",
      phrase ? "时间范围按正文事件时间划定（正文无日期时按记录时间）" : "",
    ].filter(Boolean);
    if (rank > 1 && shortCurrencies.length > 0) {
      return `${scope}已识别出金额的单笔${label}不足 ${rank} 笔，不存在${kindLabel}的一笔。（${extras.join("；")}。）`;
    }
    return `${scope}没有已识别出金额的单笔${label}记录，无法比较金额大小。${extras.length > 0 ? `（${extras.join("；")}。）` : ""}`;
  }
  // Top-N（count>1）：行内带名次，同币种内按排序位置编号（rows 已是确定性
  // ORDER BY amount 的逐币种前 N 条，顺序即名次）
  const rankWithin = new Map<string, number>();
  const lines = rows.map((n, i) => {
    const amount = formatAmount(n.amount ?? 0, n.currency || "CNY");
    const when = formatShanghai(n.created_at);
    const desc = n.is_sensitive
      ? "（加密的敏感笔记，内容不在问答中展示）"
      : `：${(n.title || n.content).replace(/\s+/g, " ").slice(0, 60)}`;
    const cite = n.is_sensitive ? "" : ` [${i + 1}]`;
    if (count > 1) {
      const cur = n.currency || "CNY";
      const r = (rankWithin.get(cur) ?? 0) + 1;
      rankWithin.set(cur, r);
      return `${r}. ${cur}：${amount}（${when}，北京时间）${cite}${desc}`;
    }
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
  let md =
    count > 1
      ? `${verdict}${scope}${kindLabel}${label}（按金额从${query.kind === "max" ? "大到小" : "小到大"}排序，同币种内比较）：\n${lines.join("\n")}`
      : rows.length === 1
        ? verdict + lines[0]
        : `${verdict}${scope}按币种分别比较（不同币种金额不可直接比较），${kindLabel}的${label}：\n${lines.join("\n")}`;
  md += `\n\n以上为数据库精确查询结果（${topic ? `按关键词${topic}匹配标题/正文/标签，` : ""}按已识别金额${count > 1 ? `排序取前 ${count} 名` : rank === 1 ? "比较" : "排序取第 " + rank + " 名"}，不含已删除笔记${phrase ? "；时间范围按正文事件时间划定（正文无日期时按记录时间）" : ""}${unknownAmount > 0 ? `；另有 ${unknownAmount} 笔未识别出金额，未参与比较` : ""}${ledgerNote ? `；${ledgerNote}` : ""}${shortNote ? `；${shortNote}` : ""}）。`;
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
  md += `\n\n以上为数据库精确查询结果（台账行级明细口径：按命中${topic}的台账明细行金额${rank === 1 ? "比较" : `排序取第 ${rank} 名`}，合计行不参与${negatives > 0 ? `；另有 ${negatives} 行负数（退款）明细未参与大小比较` : ""}${phrase ? "；时间范围按正文事件时间划定（正文无日期时按记录时间）" : ""}${shortNote ? `；${shortNote}` : ""}）。`;
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
  // 「买了咖啡豆多少次」——动宾语序把主题夹在动词与「多少次」之间
  // （R242：英文 How many times did I buy X 归一化产物的惯用语序）
  /(?:记录?|写|提到?|说|交|付|买|花|去|吃|喝)[过了]{1,2}([\u4e00-\u9fa5A-Za-z0-9]{1,12}?)(?:多少|几)次/,
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

// ---- 主题归纳问答（R221 P3-4 Q24）----
// 「最近一个月最关注的三个主题」这类归纳问题此前语义召回找不到「主题」字面
// 而径直答「没找到」。改为确定性标签频次统计（SQL 全集口径，不经 LLM），
// 并提示叙述性的主题回顾在周报/月报。
const TOPIC_SUMMARY_RE =
  /(?:最|主要|比较)关注的?[^？?。]{0,8}(?:主题|话题|方向|事情?)|(?:主题|话题)(?:是什么|有哪些)|主要在(?:想|忙|关注)些?(?:什么|啥)/;

export function topicSummaryIntent(question: string): boolean {
  return TOPIC_SUMMARY_RE.test(question);
}

/** 「三个主题」「前5个话题」里的 N；无数字默认 3，上限 10。 */
export function topicSummaryTopN(question: string): number {
  const m = question.match(/([一两二三四五六七八九十\d]{1,2})\s*[个大]?\s*(?:主题|话题|方向)/);
  if (!m) return 3;
  const CN: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (CN[m[1]] ?? 3);
  return Math.min(Math.max(n, 1), 10);
}

export function buildTopicSummaryAnswer(
  rows: { tags: string; is_sensitive: number }[],
  phrase: string | null,
  topN = 3
): string {
  const scope = phrase ?? "全部笔记里";
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.is_sensitive) continue; // 敏感笔记的标签不进入归纳展示
    try {
      for (const t of JSON.parse(r.tags || "[]") as string[]) {
        if (typeof t === "string" && t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    } catch {
      /* ignore bad rows */
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")).slice(0, topN);
  if (top.length === 0) {
    return `${scope}还没有足够的标签可以归纳主题。想看叙述性的主题回顾，可以到「报告」页生成周报/月报。`;
  }
  const lines = top.map(([t, n], i) => `${i + 1}. ${t}（${n} 条相关笔记）`);
  return `按标签出现频次统计，${scope}你最关注的主题：\n${lines.join("\n")}\n\n以上为按笔记标签的精确计数；想看叙述性的主题回顾，可到「报告」页生成周报/月报。`;
}

// ---- 支出品类归纳（R256 P3-2，audit-r255：R253 P3-2 挂账两轮）----
// 「我的钱主要花在哪些方面」此前落 LLM 兜底，只引 1 条还答「没有记录」。
// 与主题归纳（R221）同一架构：按支出笔记的标签频次+金额确定性归纳，不经 LLM。
const EXPENSE_FACET_RE =
  /(?:钱|支出|开销|开支|花销|消费)[^？?。]{0,6}(?:主要|大头|大多|基本)(?:都)?(?:花|用)(?:在|到)了?(?:哪些?|什么|啥)|(?:花|用)(?:在|到)了?(?:哪些?|什么|啥)(?:方面|类别|类型|方向)|花钱(?:的)?大头|支出(?:主要)?(?:构成|分布|结构|占比|类别)/;

export function expenseFacetIntent(question: string): boolean {
  return EXPENSE_FACET_RE.test(question);
}

/** 支出品类归纳的确定性答案：按标签频次降序，附每标签笔数与金额（按币种）。 */
export function buildExpenseFacetAnswer(
  rows: Pick<NoteRow, "tags" | "is_sensitive" | "amount" | "currency">[],
  phrase: string | null,
  topN = 5
): string {
  const scope = phrase ?? "到目前为止";
  if (rows.length === 0) {
    return `${scope}没有支出记录，无法归纳花钱方向。\n\n以上为数据库精确统计（不含已删除笔记）。`;
  }
  const stats = new Map<string, { count: number; sums: Record<string, number> }>();
  let untagged = 0;
  let sensitiveCnt = 0;
  for (const r of rows) {
    if (r.is_sensitive) {
      sensitiveCnt++;
      continue;
    }
    let tags: string[] = [];
    try {
      tags = (JSON.parse(r.tags || "[]") as string[]).filter((t) => typeof t === "string" && t);
    } catch {
      /* ignore bad rows */
    }
    if (tags.length === 0) {
      untagged++;
      continue;
    }
    for (const t of tags) {
      const s = stats.get(t) ?? { count: 0, sums: {} };
      s.count++;
      if (typeof r.amount === "number" && Number.isFinite(r.amount)) {
        const cur = r.currency || "CNY";
        s.sums[cur] = (s.sums[cur] ?? 0) + r.amount;
      }
      stats.set(t, s);
    }
  }
  const top = [...stats.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], "zh")).slice(0, topN);
  if (top.length === 0) {
    return `${scope}共 ${rows.length} 笔支出，但都没有可归纳的标签，暂无法按品类归纳。可到「报告」页生成周报/月报看叙述性归纳。`;
  }
  const lines = top.map(([t, s], i) => {
    const amounts = Object.entries(s.sums)
      .map(([cur, v]) => formatAmount(Math.round(v * 100) / 100, cur))
      .join("＋");
    return `${i + 1}. ${t}：${s.count} 笔${amounts ? `，共 ${amounts}` : ""}`;
  });
  let md = `按支出笔记的标签归纳，${scope}你的钱主要花在：\n${lines.join("\n")}`;
  const notes: string[] = [];
  if (untagged > 0) notes.push(`另有 ${untagged} 笔无标签的支出未进入归纳`);
  if (sensitiveCnt > 0) notes.push(`${sensitiveCnt} 笔加密的敏感支出不参与归纳展示`);
  if (notes.length > 0) md += `\n（${notes.join("；")}。）`;
  md += `\n\n以上为按笔记标签的精确统计（一笔可能有多个标签，各类金额不能直接相加；不含已删除笔记）。想看叙述性的分类回顾，可到「报告」页生成周报/月报。`;
  return md;
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
  // 「X和Y分别/各花了多少」是并列子集合计而非事实检索（R250 P2-3）：
  // 紧跟合计措辞的「分别/各自」先归一化掉，别被 FACT_QUERY_RE 拦下
  question = question.replace(PARALLEL_AGG_FRAME_RE, "");
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

// 主题词残片修剪（R242 P3-1，audit-r241 §4）：剥离流水线偶留句法残片——
// 结构助词「的」贴在主题两侧（「这个月的咖啡」→「的咖啡」、「咖啡的钱」）、
// 句首指代「那/这」。仅在剩余 ≥2 字时修剪，避免把「的士」剪成「士」；
// LIKE 是包含语义，剪短只会提高召回不损精确。尾部「各/各自/分别」是
// 并列问法的疑问框架（「团建各花了多少」→「团建」，R250 P2-3）。
function trimTopicResidue(term: string): string {
  let t = term;
  const lead = t.replace(/^[的那这]+/, "");
  if (lead.length >= 2) t = lead;
  // 「相关/那天」残片（R252 P3-1）：「咖啡相关」「情人节那天」剥净成主题词
  const tail = t.replace(/(?:的钱|的|各自|各|分别|相关|那天|这天|当天)+$/, "");
  if (tail.length >= 2) t = tail;
  // 「X相关的」语序（R254 P3-4，audit-r253：「书相关的支出」把「书相关的」
  // 整串注入 LIKE 必零命中）：「相关」是纯框架词不可能是主题尾字，
  // 不受 ≥2 门槛限制；剩单字主题由下游长度门槛滤掉，整题回落普通召回
  t = t.replace(/相关的?$/, "") || t;
  // 尾部结构助词同理不受 ≥2 门槛限制（R262 P2-3：「书的」注入 LIKE 必零命中）
  t = t.replace(/的$/, "") || t;
  return t;
}

/** 主题词剥离流水线（financeTopicTerms / financeShortTopicTerms 共用）。 */
function subsetTopicExtract(question: string): string[] | null {
  // 复合主题连接词会被 STRIP_RES 剥成粘连词（「耳机和键盘」→「耳机键盘」
  // 整串 LIKE 零命中，R210 P3-2，audit-r209）：先按连接词切段、逐段走同一
  // 剥离流水线再合并（等价于「逐词匹配再求和」，子集 SQL 本就是 OR 语义）
  const parts = question
    .split(TOPIC_CONNECTIVE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length > 1) {
    const out: string[] = [];
    for (const p of parts) for (const t of subsetTopicExtract(p) ?? []) if (!out.includes(t)) out.push(t);
    return out.length > 0 && out.length <= 3 ? out : null;
  }
  // 金额 token 不是主题词（R200，audit-r199 P2-1）：改写产物/追问里混入的
  // 「399元」这类金额残片不得注入 LIKE
  let residual = stripFinanceWording(question.replace(AMOUNT_TOKEN_RE, ""));
  // 时间限定词不属于主题（「2026年7月咖啡」→「咖啡」）：时间过滤由
  // parseTimeRange 负责，残留的年月日 token 一律剥掉
  residual = residual.replace(/\d{2,4}\s*年|\d{1,2}\s*月(?:份)?|\d{1,2}\s*[日号]|上+个?[月周]|这个?[月周]|本[月周]|最近|今年|去年|前年/g, "");
  // 并列疑问框架词不是主题（R250 P2-3：「买书分别花了多少」→「买书」）
  residual = residual.replace(/各自|分别/g, "");
  // 疑问代词与「这个主题」类元话语是纯框架不是主题（R262 P2-3，audit-r261：
  // 「买过什么书」抽出「什么书」、「书这个主题上」整串注入 LIKE 必零命中）
  residual = residual.replace(/些?什么|啥/g, "").replace(/[这那]个?(?:主题|话题|方面|类型|类别)上?/g, "");
  // 「在 X 上」介词框架先整体脱壳（audit-r271 P2-3 q11：「在吃喝上」经动词
  // 剥离被误啃成「喝上」）：介词「在」与框架尾「上」都不是主题，X 才是
  const frame = residual.match(/在([\u4e00-\u9fa5A-Za-z0-9]{1,8})上/);
  if (frame && /在[^\s，。？?]{1,8}上/.test(question)) residual = residual.replace(frame[0], frame[1]);
  // 剥掉开头的购买/消费动词（「买咖啡」→「咖啡」），但不能把「吃喝」这类
  // 本身就是主题的词剥空；「买过/买了」的体貌助词一并剥（R262 P2-3）
  const stripped = residual.replace(/^[买在喝吃点逛去为给用出]{1,2}[了过]?/, "").replace(/^(?:你|您|咱)+/, "");
  // 带体貌助词的「买过/买了X」剥后剩单字也接受（R262 P2-3：「买过书」→「书」，
  // 整串注入 LIKE 必零命中）：单字主题由下方 singles 门槛（hitsSingleCharTopic
  // 邻字上下文）把关；无助词的「买书」保持原样（既有 ≥2 口径，R256 P3-1）
  const aspectStripped = /^[买在喝吃点逛去为给用出]{1,2}[了过]/.test(residual);
  if (stripped.length >= 2 || (aspectStripped && stripped.length >= 1)) residual = stripped;
  // 受益格「给X/为X」的介词是纯框架（「给猫」LIKE 零命中而「猫」才是主题）：
  // 即使剥后不足 2 字也剥——剩单字会被下方长度门槛滤掉，整题回落
  // fail-closed 全账口径，仍不做心算（R242 P3-1，audit-r241 §3.2）
  residual = residual.replace(/^[给为在](?=.)/, "");
  // 「在 X 上花了多少钱」的介词框架：尾部「上」是框架残留不是主题
  // （「咖啡豆上」LIKE 零命中），仅在原问句确为「在…上」形态时剥掉
  if (/在[^\s，。？?]{1,8}上/.test(question) && residual.length >= 3) residual = residual.replace(/上$/, "");
  const terms = residual
    .split(TOPIC_CONNECTIVE_SPLIT_RE)
    .map((s) => trimTopicResidue(s.trim().replace(QUANTIFIER_TAIL_RE, "")))
    .filter(
      (s) =>
        /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) &&
        !TOPIC_ENUM_GENERIC_RE.test(s) &&
        // 「买东西/买点东西」剥掉动词后是泛指词，不构成主题限定（R242 P3-1）
        !TOPIC_ENUM_GENERIC_RE.test(s.replace(/^[买在喝吃点逛去为给用出]{1,2}/, "")) &&
        !PURE_NUMBER_RE.test(s)
    );
  if (terms.length > 0) return terms.length <= 3 ? terms : null;
  // 单字主题（R256 P3-1，audit-r255：「书相关的支出一共多少」拒答而咖啡版
  // 正确）：≥2 字门槛滤空时放宽接受单个实义汉字（语气/停用字除外），LIKE
  // 过匹配由调用方用 hitsSingleCharTopic 邻字上下文过滤（与主题枚举同一口径）。
  const singles = residual
    .split(TOPIC_CONNECTIVE_SPLIT_RE)
    .map((s) => trimTopicResidue(s.trim().replace(QUANTIFIER_TAIL_RE, "")))
    .filter(
      (s) =>
        /^[\u4e00-\u9fa5]$/.test(s) &&
        !TOPIC_ENUM_GENERIC_RE.test(s) &&
        !new RegExp(`[${FILLER_CHAR_CLASS}]`).test(s) &&
        // 原问句里该字必须独立成词（买书/书相关）；受益格「给猫花的钱」的
        // 猫不是消费对象主题，仍回落 fail-closed（R242 P3-1 口径不变）
        hitsSingleCharTopic(
          question
            .replace(/相关的?/g, "的")
            // 疑问代词/元话语框架同步剥掉（R262 P2-3），邻字判定才看得到真实语境
            .replace(/些?什么|啥/g, "")
            .replace(/[这那]个?(?:主题|话题|方面|类型|类别)上?/g, "的"),
          s
        )
    );
  return singles.length > 0 && singles.length <= 3 ? singles : null;
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
const SUBSET_TERM_TAIL_RE = /(?:是|的)?(?:什么|啥|哪个|哪家)?(?:牌子|品牌|型号|颜色|款式|口味|尺寸)$|(?:是)?(?:什么|啥)$|买的$|(?:[这那][趟次回]|一趟|这边|那边)$/;

// 亲属称谓同义映射（R224，audit-r223 P3-1）：问法「妹妹」与笔记原文「我妹」
// 字面不同导致 LIKE 零命中。降级重试时双向补上口语变体，仍是精确匹配口径。
const KINSHIP_ALIASES: [string, string][] = [
  ["妹妹", "我妹"],
  ["弟弟", "我弟"],
  ["哥哥", "我哥"],
  ["姐姐", "我姐"],
  ["爸爸", "我爸"],
  ["妈妈", "我妈"],
];

// 长 topic 短语内嵌称谓同样替换（R224 生产回归：关键词是「妹妹买生日礼物」
// 而非单独「妹妹」，原文「我妹」仍不命中——只做等值映射对审计原句无效）。
function kinshipAlias(term: string): string | null {
  for (const [long, short] of KINSHIP_ALIASES) {
    if (term.includes("我" + long)) return term.replace("我" + long, short);
    if (term.includes(long)) return term.replace(long, short);
    if (term.includes(short)) return term.replace(short, long);
  }
  return null;
}

/** 生成财务子集关键词的降级重试词集；无可降级时返回 null。 */
export function degradeFinanceSubsetTerms(terms: string[]): string[] | null {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && t.length <= 8 && !TOPIC_ENUM_GENERIC_RE.test(t) && !out.includes(t)) out.push(t);
    const alias = kinshipAlias(s.trim());
    if (alias && alias.length >= 2 && alias.length <= 8 && !out.includes(alias)) out.push(alias);
  };
  for (const t of terms) {
    // 边缘语气/介词残片（R240 P2-1 配套）：独立成段保护会让「在成都」这类
    // 介词粘连词保留下来，零命中降级时剥掉开头介词/副词字、结尾助词字各试
    // 一次（分开剥：一起剥会把「在成都」剥成「成」）
    const lead = t.replace(/^[了过是都在有和与]+/, "");
    if (lead !== t && lead.length >= 2) push(lead);
    const tail = t.replace(/[了过吗呢啊呀哦嘛吧的]+$/, "");
    if (tail !== t && tail.length >= 2) push(tail);
    // 结尾单个停用字只剥一层（「成都都」→「成都」而非「成」；「猫的钱」→「猫的」）
    const solo = t.replace(/[都是在有和与钱]$/, "");
    if (solo !== t && solo.length >= 2) {
      push(solo);
      const solo2 = solo.replace(/[了过吗呢啊呀哦嘛吧的]+$/, "");
      if (solo2 !== solo && solo2.length >= 2) push(solo2);
    }
    const stripped = t.replace(SUBSET_TERM_LEAD_RE, "").replace(SUBSET_TERM_TAIL_RE, "");
    if (stripped !== t && stripped.length >= 2) {
      push(stripped);
    } else if (t.length >= 5 && t.includes("的")) {
      for (const piece of t.split("的")) push(piece);
    } else {
      push(t);
    }
    // 动宾二字词剥动词得单字主题（R264 P2-1，audit-r263：「买书」LIKE 命不中
    // 「《置身事内》 88 元 #书籍」）：单字降级只在此处产出，且命中集必过
    // filterSingleCharTopicRows 的邻字/标签词头口径，不会引回「订书机」误命中
    const vo = t.match(/^[买购吃喝看读听玩修租借还乘坐打][\u4e00-\u9fa5]$/);
    if (vo && !out.includes(t[1]!)) out.push(t[1]!);
  }
  if (out.length === 0 || out.length > 4) return null;
  if (out.length === terms.length && out.every((t, i) => t === terms[i])) return null;
  return out;
}

// 普通召回关键词降级重试（R238 P3-3，audit-r237 §4）：LLM 关键词抽取偶发
// 过拟合出「打羽毛球打」（动宾回声残片）、「青岛这趟」（指量词残片）这类
// 无效词，整串 LIKE 零命中后直接放弃。只做两条有一手证据的最小剥离，
// 剥不出新词集则返回 null（不重试，不做宽泛分词）。
const ASK_TERM_TAIL_RE = /(?:[这那][趟次回个]|一趟|这边|那边)$/;
const CJK_TERM_RE = /^[\u4e00-\u9fff]+$/;

/** 生成普通召回关键词的降级重试词集；无可降级时返回 null。 */
export function degradeAskTerms(terms: string[]): string[] | null {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && !TOPIC_ENUM_GENERIC_RE.test(t) && !out.includes(t)) out.push(t);
  };
  for (const t of terms) {
    let s = t.replace(ASK_TERM_TAIL_RE, "");
    // 句首指代残片（R242 P3-1）：追问改写把「那」粘进关键词（「那买东西」），
    // LIKE 包含语义下剪掉句首指代字只会提高召回
    if (s.length >= 3 && CJK_TERM_RE.test(s)) s = s.replace(/^[那这](?=..)/, "");
    // 动宾回声残片：首尾同一个字（「打羽毛球打」）时剥掉尾字
    if (s.length >= 4 && CJK_TERM_RE.test(s) && s[0] === s[s.length - 1]) s = s.slice(0, -1);
    push(s);
  }
  if (out.length === 0) return null;
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
 * 仅标签命中的笔记计入合计并单列标注（R256 P3-3，audit-r255：R151 的「标签命中
 * 不计入」口径让同一批买书记录在不同问法下结果不一致，易误读；改为默认计入
 * 并如实标注来源，粒度偏宽的标签命中由用户按标注自行排除）。 */
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
  const finance = financeAll;
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
  const matchScope = tagFallback ? "仅标签命中，标题/正文无直接命中" : "标题/正文/标签";
  let md = `按关键词「${kw}」精确匹配（${matchScope}），${scope}共 ${expenseCount} 笔支出${incomeCount > 0 ? `、${incomeCount} 笔收入` : ""}：\n${totalLines.join("\n")}`;
  // 多主题并列问法（R250 P2-3，audit-r249）：「A和B各花了多少」必须逐主题
  // 拆分作答；部分主题零命中时如实声明，绝不以「精确统计」背书单主题结果。
  if (terms.length > 1) {
    const hitOf = (t: string) =>
      finance.filter((n) => !n.is_sensitive && ((n.title ?? "").includes(t) || n.content.includes(t) || (n.tags ?? "").includes(t)));
    const perLines = terms.map((t) => {
      const hits = hitOf(t);
      if (hits.length === 0) return `- 「${t}」：没有找到匹配的记账记录`;
      const sums: Record<string, { expense: number; income: number }> = {};
      for (const n of hits) {
        const amt = effAmount(n);
        if (amt === null) continue;
        const cur = n.currency || "CNY";
        sums[cur] ??= { expense: 0, income: 0 };
        if (n.category === "expense") sums[cur].expense += amt;
        else sums[cur].income += amt;
      }
      const parts = Object.entries(sums)
        .map(([cur, s]) =>
          [s.expense > 0 ? `支出 ${formatAmount(s.expense, cur)}` : null, s.income > 0 ? `收入 ${formatAmount(s.income, cur)}` : null]
            .filter(Boolean)
            .join("，")
        )
        .filter((s) => s.length > 0);
      return `- 「${t}」：${hits.length} 笔${parts.length > 0 ? `，${parts.join("；")}` : ""}`;
    });
    md += `\n\n按主题拆分：\n${perLines.join("\n")}`;
    if (sensitiveCnt > 0) md += `\n（加密的敏感记录无法按主题拆分，仅计入上方总合计。）`;
    const missing = terms.filter((t) => hitOf(t).length === 0);
    if (missing.length > 0 && missing.length < terms.length) {
      md += `\n（注意：以上合计只包含已命中的主题；「${missing.join("、")}」没有找到匹配的记账记录，如果你的记录用了别的说法，换个关键词再问试试。）`;
    }
  }
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
    md += `\n（其中 ${tagOnly.length} 笔仅标签命中「${kw}」、标题/正文不含该词，已计入合计${tagItems.length > 0 ? `：${tagItems.join("、")}` : ""}；如认为不应计入，可按标签在时间流筛选后核对。）`;
  }
  // 资金往来（transfer）不计收支合计，但直接命中时单列展示（R234 P3-3，
  // audit-r233：「信用卡还了多少钱」命中的还款笔记是 transfer，隐掉会答成
  // 「0 笔支出」答非所问）。
  const transfers = rows.filter((n) => n.category === "transfer" && !n.is_sensitive && subsetDirectHit(n, terms)).slice(0, 5);
  if (transfers.length > 0) {
    const tItems = transfers.map((n) => {
      const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
      const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
      return `${text}（${amount}，${formatShanghai(n.created_at).slice(0, 10)}）`;
    });
    md += `\n（另有 ${transfers.length} 笔资金往来/还款类记录（transfer，不计收支合计）：${tItems.join("、")}。）`;
  }
  md += `\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记${phrase ? "；时间范围按正文事件时间划定（正文无日期时按记录时间）" : ""}）。如果你的记录用了别的说法，换个关键词再问试试。`;
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
  // 收入向动词（R254 P2-2，audit-r253：「今天收到了哪些钱」被裸
  // 「哪些钱」抢成支出）：收到/到账/进账/入账 的列举变体优先于支出侧
  [/(?:收到|到账|进账|入账)[了过]?(?:的钱)?[^？?。]{0,4}?(?:哪些|些什么|什么)(?:钱|款)?|(?:哪些|什么)钱(?:收到|到账|进账|入账)/, "income"],
  // 「哪几笔」无方向词时按收支双向列（R250 P2-2：无历史的「去年下半年
  // 分别是哪几笔」与追问式同一管道收口，不平行打补丁）
  [/记[了过]?(?:哪些|些什么|什么)账|账单(?:明细)?(?:都)?有哪些|收支明细|哪几笔/, "both"],
  // 笔数问法统一进确定性列举管道（R262 P1-3，audit-r261 §P1-3：「今年收入
  // 总共有几笔？分别是什么」被 FACT_QUERY 的「分别/是什么」拦下落普通召回，
  // LLM 对截断召回心算出「1 笔」，与 F30 聚合答案自相矛盾）。笔数与金额
  // 必须同源：列举答案头行的「共 X 笔」与合计同出一条 SQL。方向词覆盖
  // （financeListWordDirection）照常生效。
  [/几笔|多少笔/, "both"],
  // 「花了哪些钱/花了些什么钱」「哪些钱」「钱都花在哪了」
  [/花了?(?:哪些|些什么|什么)钱|哪些钱|钱(?:都)?(?:花|用)(?:在|到)了?(?:哪|什么)/, "expense"],
  // 「有哪些支出/开销」「支出有哪些」「消费明细」「列一下开销」
  [/(?:支出|开支|开销|花销|消费)(?:记录|明细|情况)?(?:都)?有哪些|有(?:过)?(?:哪些|些什么|什么)(?:支出|开支|开销|花销|消费)|(?:支出|开支|开销|花销|消费)明细|列(?:一下|出|举)?[^？?。]{0,6}(?:支出|开支|开销|花销|消费)/, "expense"],
  // 尾部裸「买了什么」（R250 P2-2）：句尾无主题词才算（「买了哪些书」
  // 不在此列，留给主题子集/普通召回）
  [/买[了过]?(?:些)?(?:哪些|什么|啥)(?:东西)?\s*[？?。！!]*$/, "expense"],
];

// 方向词 × 列举动词解耦兜底（R254 P2-3，audit-r253：「我所有收入列一下」
// 「把咱的支出都列一下」等倒装/口语语序不在 CUES 的固定语序内）：
// 列举意图与方向词分别命中即可，语序不限；主题限定仍由下方同一
// 剥离口径的残留门拦住（「列一下买书的支出」残留「书」→ null）。
const FINANCE_LIST_VERB_RE = /列(?:出来|出|举|一下|个?清单)|罗列|都列|拉个?清单/;
const FINANCE_LIST_INCOME_WORD_RE = /收入|进账|入账/;
const FINANCE_LIST_EXPENSE_WORD_RE = /支出|开支|开销|花销|消费|花费/;

function financeListLooseDirection(question: string): FinanceListDirection | null {
  if (!FINANCE_LIST_VERB_RE.test(question)) return null;
  return financeListWordDirection(question);
}

// R258 P2-2（audit-r257）：方向词是正交限定维度——「本月收入有哪几笔」被
// 无方向的「哪几笔」cue 抢成收支双向。问句里的显式收/支名词覆盖 cue 的
// 默认方向；无显式方向词时保持 cue 方向不变（单限定行为零改动）。
function financeListWordDirection(question: string): FinanceListDirection | null {
  const inn = FINANCE_LIST_INCOME_WORD_RE.test(question);
  const out = FINANCE_LIST_EXPENSE_WORD_RE.test(question);
  if (inn && out) return "both";
  if (inn) return "income";
  if (out) return "expense";
  return null;
}

/** 财务列举方向的统一判定（cue 语序 + 松散语序 + 显式方向词覆盖）。 */
function financeListDirectionOf(question: string): FinanceListDirection | null {
  let direction: FinanceListDirection | null = null;
  for (const [re, dir] of FINANCE_LIST_CUES) {
    if (re.test(question)) {
      direction = dir;
      break;
    }
  }
  direction ??= financeListLooseDirection(question);
  if (!direction) return null;
  return financeListWordDirection(question) ?? direction;
}

/** 识别财务列举问题（「花了哪些钱」）；带主题限定（「买了哪些书」）返回 null。 */
export function financeListIntent(question: string): FinanceListDirection | null {
  const direction = financeListDirectionOf(question);
  if (!direction) return null;
  // 残留主题词（「买了哪些书花了哪些钱」「列一下买书的支出」）说明不是纯
  // 财务列举：单字残留（书/车/药）同样是主题限定（R256 P2-3，audit-r255：
  // 「列一下买书的支出」残留「书」被 <2 门槛放行，吞掉限定回了全部 16 笔），
  // 留给主题列举（financeListTopicTerms）/普通召回。
  return financeListResidual(question).length === 0 ? direction : null;
}

const FINANCE_LIST_STRIP_RE =
  /最近|近来|这段时间|一段时间|到目前为止|至今|哪些|些什么|什么|东西|明细|记录|清单|情况|列出来|列出|列举|列一下|列个?清单|罗列|拉个?清单|列|买|花在|花到|用在|用到|地方|各|分别|哪里|哪儿|哪|逐[笔条项个]?|一笔笔|一条条|挨个|笔|记|账|所有|全部|我们?|你|咱|把|都|请|麻烦|帮我?|给我|收到|到账|款|别人|有人|人家|转给|打给|转来|转过来|打过来|汇给|汇过来|是|的|钱/g;

function financeListResidual(question: string): string {
  return applyStrips(question, [...STRIP_RES, FINANCE_LIST_STRIP_RE]);
}

/**
 * 财务列举 + 主题限定（R256 P2-3，audit-r255）：「列一下买书的支出」走
 * 「关键词匹配 + 确定性列举合计」（buildFinanceSubsetAnswer 同一口径），
 * 绝不丢掉限定条件回全量列举。纯列举（无残留主题）交 financeListIntent。
 */
export function financeListTopicTerms(question: string): { direction: FinanceListDirection; terms: string[] } | null {
  const direction = financeListDirectionOf(question);
  if (!direction) return null;
  if (FACT_QUERY_RE.test(question.replace(/哪些|分别/g, ""))) return null;
  const residual = financeListResidual(question);
  if (residual.length === 0) return null;
  const terms = residual
    .split(TOPIC_CONNECTIVE_SPLIT_RE)
    .map((s) => trimTopicResidue(s.trim().replace(QUANTIFIER_TAIL_RE, "")))
    .filter(
      (s) =>
        /^[\u4e00-\u9fa5A-Za-z0-9]{1,8}$/.test(s) &&
        !TOPIC_ENUM_GENERIC_RE.test(s) &&
        !PURE_NUMBER_RE.test(s) &&
        !(s.length === 1 && new RegExp(`[${FILLER_CHAR_CLASS}]`).test(s))
    );
  return terms.length > 0 && terms.length <= 3 ? { direction, terms } : null;
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
  phrase: string | null,
  transferCount = 0
): string {
  const scope = phrase ?? "到目前为止";
  const label = FINANCE_LIST_LABELS[direction];
  const caliber = `以上为按记账笔记的数据库精确列举（口径与周报/月报一致，不含已删除笔记；待办等尚未发生的计划不计入${phrase ? "；时间范围按正文事件时间划定（正文无日期时按记录时间）" : ""}）。`;
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
  if (transferCount > 0) md += `\n（另有 ${transferCount} 笔资金往来（内转/提现/借还），不计入收支合计。）`;
  md += `\n\n${caliber}`;
  return md;
}

// ---- 财务聚合后的裸列举追问（R248 P1，audit-r247 F-1）----
// 「能列一下吗/分别是哪几笔/都花在什么上了」这类追问自身无财务列举措辞，
// 依赖 rewriteAskQuestion 注入历史上下文，而改写产物会把上一轮答案里的
// 「收入 ¥12000」等措辞带入，污染基于改写产物的确定性财务意图回退
// （R247 实测「能列一下吗」4/4 误判为仅收入并假否定「没有支出」）。与
// 口径澄清（financeClarifyTerms）同一闸：上一轮是精确合计答案（尾注标识）
// 且本轮是不带主题词的裸列举追问时——
// - 带财务方向线索（笔/花/支出/收入…）→ 返回方向，确定性路由到财务列举，
//   方向词只认本轮原问题，绝不认改写产物；无方向词的财务线索继承上一轮
//   收支口径（both）。
// - 纯泛列举（「都有哪些」「能列一下吗」）→ 返回 "generic"：只关闭改写
//   产物的财务意图回退（同元问题闸原理），仍走既有枚举/普通召回管道
//   （R247 实测「都有哪些」4/4 正常，不改变其行为）。
const BARE_LIST_CUE_RE = /哪些|哪几笔|哪几个|哪几条|哪几项|哪几样|列(?:一下|出|举|下)|花(?:在|到)了?(?:什么|哪)|明细|清单/;
const BARE_LIST_STRIP_RE =
  /^那|^这|都|全部|所有|具体|分别|各自?|能不能|可不可以|能|可以|麻烦|请|帮我|给我|再|又|是|吗|么|嘛|呢|吧|啊|呀|一下|下|出来?|看看|哪些|哪几笔|哪几个|哪几条|哪几项|哪几样|些什么|什么|记录|笔记|明细|清单|列举?|罗列|列|花(?:在|到)|用(?:在|到)|上了?|哪[儿里]?|在|有|了|钱|账|各|笔|项|条|样|的/g;

export type FinanceListFollowUp = FinanceListDirection | "generic";

/** 财务合计答案后的裸列举追问：财务方向 / 纯泛列举 "generic" / 非此类 null。 */
export function financeListFollowUpIntent(question: string, lastAssistant: string | null): FinanceListFollowUp | null {
  if (!lastAssistant || !FINANCE_AGG_MARK_RE.test(lastAssistant)) return null;
  const q = question.replace(/[？?。！!，,\s]+/g, "");
  if (q.length === 0 || q.length > 16 || !BARE_LIST_CUE_RE.test(q)) return null;
  // 残留主题词（「买了哪些书」）说明不是裸列举：留给主题子集/普通召回
  const residual = applyStrips(q, [...STRIP_RES, BARE_LIST_STRIP_RE]);
  if (residual.length >= 2) return null;
  if (/收入|进账|入账|收[到过了]|[赚挣]/.test(q)) return "income";
  if (/支出|开支|开销|花销|消费|[花用](?:在|到)/.test(q)) return "expense";
  if (/[笔账]|明细|清单|钱/.test(q)) return "both";
  return "generic";
}

// R258 P2-3（audit-r257）：关键词子集合计（「今年买书花了多少」）的裸列举
// 追问（「分别是哪几笔」）此前只继承时间窗、吞掉关键词限定回全量列举。
// buildFinanceSubsetAnswer 的答案口径里已如实回显了关键词（「按关键词「买书」
// 精确匹配」），追问从上一轮答案解析出该保留集——time window / keyword /
// direction 三个限定维度正交携带，不新增会话状态实体。
const FINANCE_SUBSET_KW_RE = /按关键词「([^」]{1,32})」精确匹配/;
// 子集答案头行的方向笔数（buildFinanceSubsetAnswer：「共 X 笔支出、Y 笔收入」）
const FINANCE_SUBSET_DIR_RE = /共 (\d+) 笔支出(?:、(\d+) 笔收入)?/;

/** 上一轮精确合计答案里的关键词限定集；非关键词子集答案返回 null。
 * 方向显式切换撤销继承（R260 P1-1，audit-r259）：本轮追问显式点名的方向在
 * 上一轮子集答案里为零笔（「买书」支出合计后问「本月收入有哪几笔」）时，
 * 用户已切出该关键词话题，继承只会得到 0 笔误答——撤销继承，让追问按本轮
 * 显式方向走全量列举（时间窗仍按本轮问题优先的既有口径）。 */
export function financeAggAnswerTerms(
  lastAssistant: string | null,
  followUpDir: FinanceListFollowUp | null = null
): string[] | null {
  const m = lastAssistant?.match(FINANCE_SUBSET_KW_RE);
  if (!m) return null;
  if (followUpDir === "income" || followUpDir === "expense") {
    const d = lastAssistant!.match(FINANCE_SUBSET_DIR_RE);
    if (d) {
      const cnt = followUpDir === "expense" ? parseInt(d[1], 10) : parseInt(d[2] ?? "0", 10);
      if (cnt === 0) return null;
    }
  }
  const terms = m[1]
    .split("、")
    .map((s) => s.trim())
    .filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{1,8}$/.test(s));
  return terms.length > 0 && terms.length <= 3 ? terms : null;
}

/** 上一轮精确合计答案头行的时间窗。追问只允许继承答案头行（合计口径行）
 * 里的时间短语；正文逐笔明细会回显笔记原文，笔记里写的「这个月/今天」等
 * 字样若参与解析会污染继承口径（如把「今年」窄化成当月）。 */
export function answerHeadTimeRange(lastAssistant: string | null, now: Date = new Date()): TimeRange | null {
  if (!lastAssistant) return null;
  return parseTimeRange(lastAssistant.split("\n")[0], now);
}

// ---- 财务金额阈值筛选（R240 P2-3，audit-r239 §4.4）----
// 「列出超过 80 元的支出」是一条 WHERE amount > ? 就能精确回答的问题，
// 此前无确定性管道，落 LLM 对截断召回筛选（漏项/心算错）。与极值/列举
// 同一家族：按币种限定比较（不同币种金额不可直接比阈值），台账合计笔记
// 不当单笔参与（口径同极值）。

export interface FinanceThresholdQuery {
  direction: "expense" | "income";
  op: "gt" | "gte" | "lt" | "lte";
  amount: number;
  /** 比较币种（问句未写币种词时默认 CNY） */
  currency: string;
}

const THRESHOLD_CURRENCY: Record<string, string> = PREMISE_CURRENCY;
const THRESHOLD_PRE_RE =
  /(超过|超出|大于|高于|多于|不低于|不少于|至少|低于|少于|小于|不到|不足|不超过|不高于|至多)\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(元|块钱?|人民币|rmb|cny|美元|美金|usd|日元|jpy|欧元|eur|英镑|gbp|港[币元]|hkd|韩元|krw)?/i;
const THRESHOLD_POST_RE =
  /(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(元|块钱?|人民币|rmb|cny|美元|美金|usd|日元|jpy|欧元|eur|英镑|gbp|港[币元]|hkd|韩元|krw)\s*(以上|以内|以下)/i;
const THRESHOLD_OPS: Record<string, FinanceThresholdQuery["op"]> = {
  超过: "gt", 超出: "gt", 大于: "gt", 高于: "gt", 多于: "gt",
  不低于: "gte", 不少于: "gte", 至少: "gte", 以上: "gte",
  低于: "lt", 少于: "lt", 小于: "lt", 不到: "lt", 不足: "lt",
  不超过: "lte", 不高于: "lte", 至多: "lte", 以内: "lte", 以下: "lte",
};

function parseThresholdAmount(s: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return parseNum(s);
}

/** 识别金额阈值筛选问法（「列出超过 80 元的支出」）；非此类返回 null。 */
export function financeThresholdIntent(question: string): FinanceThresholdQuery | null {
  if (ASK_PRONOUN_REF_RE.test(question)) return null;
  // 必须是支出/收入类财务名词限定的筛选（「打卡超过3次」不是）
  if (!/支出|开支|开销|花销|花费|消费|收入|进账|入账|账单|记账/.test(question)) return null;
  // 极值/序数/Top-N 问法交既有极值管道（「超过80元里最贵的」）
  if (financeExtremeIntent(question)?.count || /最贵|最便宜|最[大小高低多少]/.test(question)) return null;
  let m = question.match(THRESHOLD_PRE_RE);
  let opWord: string | undefined;
  let numStr: string | undefined;
  let curWord: string | undefined;
  if (m) {
    [, opWord, numStr, curWord] = m;
    // 「超过100笔/次/天」是数量阈值不是金额：无币种词且数字后紧跟量词时不收口
    const after = question.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1);
    if (!curWord && /[笔次条个天回趟顿]/.test(after)) return null;
  } else {
    m = question.match(THRESHOLD_POST_RE);
    if (!m) return null;
    [, numStr, curWord, opWord] = m;
  }
  const amount = numStr ? parseThresholdAmount(numStr) : null;
  const op = opWord ? THRESHOLD_OPS[opWord.toLowerCase()] : undefined;
  if (amount === null || !op) return null;
  const direction: "expense" | "income" = /收入|进账|入账/.test(question) ? "income" : "expense";
  const currency = curWord ? (THRESHOLD_CURRENCY[curWord.toLowerCase()] ?? "CNY") : "CNY";
  return { direction, op, amount, currency };
}

/** 阈值问法的主题限定词（「超过80元的餐饮支出」→「餐饮」）；无限定返回 null。
 * 剥不干净（残留无法成词）返回 ["\u0000"] 哨兵由调用方放弃收口，绝不答超范围列表。 */
export function financeThresholdTopicTerms(question: string): string[] | null {
  const cleaned = question
    .replace(THRESHOLD_PRE_RE, "")
    .replace(THRESHOLD_POST_RE, "")
    .replace(AMOUNT_TOKEN_RE, "");
  const residual = applyStrips(cleaned, [
    ...STRIP_RES,
    /有哪些|哪些|都有什么|些什么|什么|列出|列举|列一下|罗列|盘点|清单|列表|明细|记录|笔记|各|分别|每笔|逐笔|单笔|几笔|一共|总共|超过|超出|大于|高于|多于|不低于|不少于|至少|低于|少于|小于|不到|不足|不超过|不高于|至多|以上|以内|以下|列|笔|的/g,
  ]).trim();
  if (residual.length < 2) return null;
  const terms = residual
    .split(TOPIC_CONNECTIVE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const clean = terms.filter((s) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/.test(s) && !TOPIC_ENUM_GENERIC_RE.test(s) && !PURE_NUMBER_RE.test(s));
  if (clean.length === terms.length && clean.length >= 1 && clean.length <= 3) return clean;
  return ["\u0000"]; // 剥离残渣不成词：放弃确定性收口（fail-safe）
}

const THRESHOLD_OP_LABELS: Record<FinanceThresholdQuery["op"], string> = {
  gt: "超过",
  gte: "不低于",
  lt: "低于",
  lte: "不超过",
};

/** 金额阈值筛选的确定性答案：逐笔列举 + 精确总数；台账合计/未识别金额如实说明。 */
export function buildFinanceThresholdAnswer(
  query: FinanceThresholdQuery,
  rows: Pick<NoteRow, "id" | "title" | "content" | "created_at" | "is_sensitive" | "amount" | "currency">[],
  extra: { unknownAmount: number; otherCurrency: number; ledgerExcluded: number },
  phrase: string | null,
  topicTerms: string[] | null
): string {
  const scope = phrase ?? "到目前为止";
  const dirLabel = FINANCE_DIRECTION_LABELS[query.direction];
  const topicLabel = topicTerms ? `「${topicTerms.join("/")}」相关的` : "";
  const cond = `${THRESHOLD_OP_LABELS[query.op]} ${formatAmount(query.amount, query.currency)}`;
  const notes: string[] = [];
  if (extra.ledgerExcluded > 0) notes.push(`另有 ${extra.ledgerExcluded} 笔台账多笔合计笔记（金额是列合计非单笔），未参与单笔比较`);
  if (extra.unknownAmount > 0) notes.push(`另有 ${extra.unknownAmount} 笔未识别出金额，无法参与比较`);
  if (extra.otherCurrency > 0) notes.push(`另有 ${extra.otherCurrency} 笔其他币种记录（不同币种金额不可直接比较阈值），未列入`);
  const noteLine = notes.length > 0 ? `\n（${notes.join("；")}。）` : "";
  const caliber = `\n\n以上为按金额的数据库精确筛选（口径与周报/月报一致，不含已删除笔记${topicTerms ? "；主题按关键词匹配" : ""}）。`;
  if (rows.length === 0) {
    return `${scope}没有找到${topicLabel}金额${cond}的${dirLabel}记录。${noteLine}${caliber}`;
  }
  const visible = rows.filter((n) => !n.is_sensitive).slice(0, 20);
  const itemLines = visible.map((n, i) => {
    const amount = typeof n.amount === "number" && Number.isFinite(n.amount) ? formatAmount(n.amount, n.currency || "CNY") : "金额未识别";
    const text = (n.title || n.content.split("\n")[0] || "").replace(/\s+/g, " ").slice(0, 40);
    return `- ${text}（${amount}，${formatShanghai(n.created_at).slice(0, 10)}）[${i + 1}]`;
  });
  const sensitiveCnt = rows.filter((n) => n.is_sensitive).length;
  const total = rows.reduce((s, n) => (typeof n.amount === "number" && Number.isFinite(n.amount) ? s + n.amount : s), 0);
  let md = `${scope}${topicLabel}金额${cond}的${dirLabel}共 ${rows.length} 笔，合计 ${formatAmount(total, query.currency)}`;
  if (itemLines.length > 0) md += `：\n${itemLines.join("\n")}`;
  if (rows.length > visible.length && sensitiveCnt === 0) md += `\n（共 ${rows.length} 笔，仅展示前 ${visible.length} 笔。）`;
  if (sensitiveCnt > 0) md += `\n（含 ${sensitiveCnt} 笔加密的敏感记录，计入总数，内容不在问答中展示。）`;
  md += noteLine + caliber;
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
  // 英文分类名（R252 P3-4）："What ideas have I recorded?" 按分类精确筛选
  idea: "idea",
  ideas: "idea",
  todo: "todo",
  todos: "todo",
};

/** 分类名主题词 → category（大小写不敏感，英文归一化小写；非分类名返回 null）。 */
export function enumTopicCategory(topic: string): string | null {
  return ENUM_TOPIC_CATEGORIES[topic] ?? ENUM_TOPIC_CATEGORIES[topic.toLowerCase()] ?? null;
}

// R258 P3-3（audit-r257）：「我有什么待办事项」这类分类名直问枚举此前无
// 枚举 cue（哪些/列/所有）可走，落语义召回漏报。分类名词典可枚举、误伤面
// 可控：残留门保证「有哪些关于健身的想法」这类带主题限定的问法不被劫走
// （残留非空 → null，仍走既有主题枚举/普通召回）。
const CATEGORY_ENUM_FRAME_STRIP_RE =
  /有(?:什么|哪些|啥)|都有什么|哪些|什么|清单|列表|列(?:一下|出|举)?|要办|要做|没做|未完成|事项|事情|现在|目前|还|我的?|你|您|咱|帮我|给我|请|麻烦|所有|全部|都|吗|么|嘛|呢|吧|啊|呀|的|有|了/g;

/** 分类名直问枚举（「我有什么待办事项」→「待办」）；非此类返回 null。 */
export function categoryEnumIntent(question: string): string | null {
  if (FINANCE_WORD_RE.test(question) || ASK_PRONOUN_REF_RE.test(question)) return null;
  const q = question.replace(/[？?。！!，,\s]+/g, "");
  if (q.length === 0 || q.length > 16) return null;
  const m = q.match(/待办事项|待办|todos?|想法|点子|收藏|资料|ideas?/i);
  if (!m || !enumTopicCategory(m[0])) return null;
  if (!/有(?:什么|哪些|啥)|都有什么|哪些|清单|列表|列(?:一下|出|举)|要办|要做/.test(q)) return null;
  const residual = applyStrips(q.replace(m[0], ""), [STRIP_RES[0], CATEGORY_ENUM_FRAME_STRIP_RE]);
  return residual.length === 0 ? m[0] : null;
}

// R258 P3-1（R251 P3-2 收尾，audit-r257）：裸时间短语问题（「3月份」）无任何
// 财务/枚举措辞，此前落语义召回拒答。整句剥掉时间短语与语气词后残留为空
// 时即「该时间窗记了什么」的省略问法，走既有时间窗枚举管道精确列举。
const BARE_TIME_FRAME_STRIP_RE = /呢|呀|啊|吗|么|嘛|吧|都|有|的|记录|笔记|情况|怎么样|怎样|如何/g;

/** 裸时间短语问题（「3月份」「上个月」）：可路由时间窗枚举时返回 true。 */
export function bareTimeWindowListIntent(question: string): boolean {
  const q = question.replace(/[？?。！!，,\s]+/g, "");
  if (q.length === 0 || q.length > 12) return false;
  if (!parseTimeRange(q)) return false;
  return applyStrips(q, [STRIP_RES[0], BARE_TIME_FRAME_STRIP_RE]).length === 0;
}

// 「有什么记录」cue 的主题限定门（R262 P2-4，audit-r261：「我对咖啡豆供应商
// 有什么记录」被劫成全库精确列举答非所问）：该 cue 只服务裸时间窗问法，
// cue 前后剥掉时间/语气词仍有残留（主题限定）时不走全库列举。
const ENUM_LIST_HAVE_CUE_RE = /有(?:些|哪些|什么|啥)(?:记录|笔记)/;
const ENUM_LIST_FILLER_STRIP_RE = /[？?。！!，,\s]|我们?|你|您|咱|都|还|里|中|内|期间|这段时间|一共|总共|具体|所有|全部|东西|事情|事儿?|内容|信息|的|有|了|呢|呀|啊|吗|么|嘛|吧/g;

/** 「这段时间都记了什么/记了哪些/有什么记录」——时间窗枚举，走 SQL 全量列举而非 top-k 召回。 */
export function enumListIntent(question: string): boolean {
  if (/都记[了过]?(?:些|哪些)?什么|记[了过](?:些什么|哪些)|都写[了过]?(?:些|哪些)?什么|都有哪些笔记|记录[了过](?:些什么|哪些|什么)/.test(question)) return true;
  if (!ENUM_LIST_HAVE_CUE_RE.test(question)) return false;
  return applyStrips(question.replace(ENUM_LIST_HAVE_CUE_RE, ""), [STRIP_RES[0], BARE_TIME_FRAME_STRIP_RE, ENUM_LIST_FILLER_STRIP_RE]).length === 0;
}

// ---- 主题枚举问答（R130 P1-1/P1-2）----
// 「我看过什么书/存过哪些菜谱」这类枚举+主题词问题：宽泛主题词的语义 top-k
// 在小语料下会被高频主题压过（R129 R8：问「书」召回全是健身笔记），必须先走
// 关键词/标签 LIKE 全量筛选（与财务/计数/极值同一精确查询家族），语义召回只
// 在关键词零命中时兜底。序数追问（「第二本讲什么」）依赖首轮枚举成功 + 既有
// 历史改写解析，不为序数单独增加状态实体。

const TOPIC_ENUM_RES: RegExp[] = [
  // 「存过哪些菜谱」「看过什么书」——经历/收纳动词 + 些/哪些/什么 + 主题名词收尾
  /(?:[看读买去吃喝听学玩逛用聊提存记写收藏保]{1,2}|记录)[过了]{1,2}(?:些|哪些|什么|啥)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)(?:的?(?:笔记|记录|内容|想法|点子))?(?:来着|呢|吗|么)?$/,
  // 「记过哪些关于 AI 创业的想法」——枚举措辞 + 关于/有关 + 主题词
  /[过了]?(?:些|哪些|什么|啥)(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容|想法|点子|事)?$/,
  // 「关于健身的笔记有哪些」「有哪些关于健身的记录」
  /(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容)?(?:都)?有哪些/,
  /有哪些(?:关于|有关)([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)的?(?:笔记|记录|内容)/,
  // 「我对咖啡豆供应商有什么记录」（R262 P2-4，audit-r261：此前被无主题的
  // 「有什么记录」cue 劫成全库精确列举）：「对/就 X」的介词宾语是主题限定
  /[对就]([\u4e00-\u9fa5A-Za-z0-9 ]{1,12}?)(?:[这那]个?(?:主题|方面))?有(?:什么|哪些|啥)(?:记录|笔记|内容)/,
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
  // 分类名直问（R258 P3-3）：「我有什么待办事项」确定性路由 category 精确
  // 筛选，不依赖语义召回也不必问 LLM
  const catTopic = categoryEnumIntent(question) ?? categoryEnumIntent(recallQuestion);
  if (catTopic) return { topic: catTopic, list: false, extreme: null };
  const reTopic = topicEnumIntent(question) ?? topicEnumIntent(recallQuestion);
  const reList = enumListIntent(question) || enumListIntent(recallQuestion);
  if (reTopic && !reList) return { topic: reTopic, list: false, extreme: null };
  // 分类名主题（想法/待办/ideas…）与时间窗枚举同时命中时不必问 LLM：
  // 「记录过哪些想法」明确要的是该分类筛选，不是全量列举（R252 P3-4）
  if (reTopic && reList && enumTopicCategory(reTopic)) return { topic: reTopic, list: false, extreme: null };
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

/**
 * 记账口径问答（R290 P2，audit-r289 §8：`退款算收入还是支出的冲减？` 被答成
 * 「退款算收入」）：口径是本产品自己的记账规则（triage 系统提示里已写死
 * 「同一笔交易的退款是价款冲减」），不是可由 LLM 现场推断的知识——由代码
 * 确定性作答，避免与实际入账口径自相矛盾。
 */
export function financeCaliberAnswer(question: string): string | null {
  const q = question.replace(/\s+/g, "");
  if (!/退款|退货|返现|退回|退了/.test(q)) return null;
  if (!/算|计入|归为|属于|方向|口径|收入还是|支出还是|怎么记|如何记/.test(q)) return null;
  return [
    "退款按「支出冲减」记，不算收入。",
    "",
    "- 同一笔交易的退款（「付款 34.5 其中退款 9」「午饭 20 咖啡 -5(退款)」）是价款冲减：整笔按净额记为支出，退款金额不单独计入收入。",
    "- 台账里的退款行同样按相反方向扣减合计（「打印纸 120 墨盒 260 供应商退款 454」→ 净支出）。",
    "- 只有退款超过支出、净额为负时才是净流入，此时按收入记该净额。",
    "- 押金退回、借还、垫付收回是资金往来或收入回补，与商家退款不同口径。",
  ].join("\n");
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

// ---- 单字主题枚举命中校验（R240 P3-2，audit-r239 §5 r08）----
// 「我买了什么书」的主题词是单字「书」，LIKE '%书%' 会把「放在书房柜子里」
// 的路由器资料也列成「和书相关」。无分词能力下按邻字上下文判定该字是否
// 独立成词：任一处出现满足「前邻是边界/量词/动词/助词（本书/买书/的书）
// 且后邻是边界/助词（书。/书的/书吗）」即命中。代价是「书单/书评」这类
// 相关复合词命中会被过滤（准确优先；答案已注明按关键词筛选、可换说法再问），
// 调用方在过滤后全空时回落原始命中，绝不因此把有命中变成零命中。
const SINGLE_TOPIC_PREV_RE = /[本些的了过在买看读借还送写记听唱学做煮炒烧一两三几每部套张首道口条只株盆杯瓶箱袋]/;
const SINGLE_TOPIC_NEXT_RE = /[的了是吗么呢啊呀哦嘛吧也都还很一]/;
const CJK_CHAR_RE = /[\u4e00-\u9fa5]/;

/** 单字主题在文本中是否有「独立成词」的出现（邻字上下文判定）。 */
export function hitsSingleCharTopic(hay: string, ch: string): boolean {
  let idx = hay.indexOf(ch);
  while (idx !== -1) {
    const prev = idx > 0 ? hay[idx - 1]! : "";
    const next = idx + 1 < hay.length ? hay[idx + 1]! : "";
    const prevOk = prev === "" || !CJK_CHAR_RE.test(prev) || SINGLE_TOPIC_PREV_RE.test(prev);
    const nextOk = next === "" || !CJK_CHAR_RE.test(next) || SINGLE_TOPIC_NEXT_RE.test(next);
    if (prevOk && nextOk) return true;
    idx = hay.indexOf(ch, idx + 1);
  }
  return false;
}

// ---- 关系限定词忠实性护栏（R256 P1-1，audit-r255）----
// 「我给女朋友买过什么礼物」在全库无「女朋友」字样时，召回命中的买书笔记
// 被 LLM 硬凑成「给女朋友买的礼物」并带引用（R255 生产实测 1/1）。问题里的
// 人物关系限定词在全部召回文本（含同义变体）中零出现时，片段不可能支撑该
// 关系事实——生成前确定性短路到既有 not_in_notes 拒答通道（与 R244 时间窗
// 短路同一架构，不平行打补丁）。只收人物关系词（词典可枚举、误伤面可控），
// 不做开放实体抽取。问法侧正则从严（「对象/先生」等歧义词不进问法侧），
// 笔记侧同义词从宽（口语变体都算支撑，口径同 R224 亲属称谓映射）。
const RELATION_FAMILIES: { q: RegExp; syn: string[] }[] = [
  { q: /女朋友|女友|女票|\bgirlfriend\b/i, syn: ["女朋友", "女友", "女票", "对象"] },
  { q: /男朋友|男友|男票|\bboyfriend\b/i, syn: ["男朋友", "男友", "男票", "对象"] },
  { q: /老婆|妻子|媳妇|太太|\bwife\b/i, syn: ["老婆", "妻子", "媳妇", "太太", "爱人"] },
  { q: /老公|丈夫|\bhusband\b/i, syn: ["老公", "丈夫", "爱人", "先生"] },
  { q: /爸爸|父亲|老爸|我爸|\b(?:dad|father)\b/i, syn: ["爸爸", "父亲", "老爸", "我爸", "爸妈", "父母"] },
  { q: /妈妈|母亲|老妈|我妈|\b(?:mom|mother)\b/i, syn: ["妈妈", "母亲", "老妈", "我妈", "爸妈", "父母"] },
  { q: /父母|爸妈/, syn: ["父母", "爸妈", "爸爸", "妈妈", "父亲", "母亲", "我爸", "我妈"] },
  { q: /儿子/, syn: ["儿子", "孩子", "娃"] },
  { q: /女儿|闺女/, syn: ["女儿", "闺女", "孩子", "娃"] },
  { q: /孩子|小孩/, syn: ["孩子", "小孩", "儿子", "女儿", "娃"] },
  { q: /哥哥/, syn: ["哥哥", "我哥"] },
  { q: /姐姐/, syn: ["姐姐", "我姐"] },
  { q: /弟弟/, syn: ["弟弟", "我弟"] },
  { q: /妹妹/, syn: ["妹妹", "我妹"] },
  { q: /爷爷/, syn: ["爷爷", "祖父"] },
  { q: /奶奶/, syn: ["奶奶", "祖母"] },
  { q: /外公|姥爷/, syn: ["外公", "姥爷"] },
  { q: /外婆|姥姥/, syn: ["外婆", "姥姥"] },
  { q: /同事|\b(?:colleague|coworker)\b/i, syn: ["同事"] },
  { q: /室友|\broommate\b/i, syn: ["室友"] },
  { q: /邻居|\bneighbou?r\b/i, syn: ["邻居"] },
  // 「客户端」是技术名词不是人物关系（语言归一把 LCP 译成「客户端首屏」类
  // 措辞时，子串命中会对 OKR 技术问句误触发关系拒答）
  { q: /客户(?!端)|\b(?:client|customer)\b/i, syn: ["客户"] },
  { q: /领导|上司/, syn: ["领导", "上司", "老板"] },
];

/**
 * 问题里无法在召回文本中落地的人物关系限定词；全部可落地/无关系词时返回 null。
 * 「朋友」不单独收（女朋友/男朋友的子串，单收会误拦泛指问法）。
 */
export function ungroundedRelationTerm(question: string, sourceText: string): string | null {
  for (const fam of RELATION_FAMILIES) {
    const m = question.match(fam.q);
    if (!m) continue;
    if (!fam.syn.some((s) => sourceText.includes(s))) return m[0];
  }
  return null;
}

/** 标签是否以单字主题为词头（R264 P2-1，audit-r263 §2.3）：标签是分拣产出的
 * 主题词而非自由文本，「书籍/书单/书评」这类以该字开头的标签是主题上位词，
 * 不是「订书机」式的复合词误命中；正文邻字规则对标签不适用（JSON 串里
 * 邻字是标签内部字符），单独按词头判。 */
export function tagHitsSingleCharTopic(tagsJson: string | null | undefined, ch: string): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson) as unknown[];
    return tags.some((t) => typeof t === "string" && t.startsWith(ch));
  } catch {
    return false;
  }
}

/** 单字主题词的行集过滤（R256 P3-1）：LIKE '%书%' 会把「订书机/书房」这类
 * 复合词也命中，按邻字上下文只保留独立成词的行；全被滤掉时如实返回空
 * （宁缺毋滥：把「订书机」算进「书」的合计是错答，零命中走 fail-closed
 * 诚实说明）。多字词命中的行一律保留；以该字为词头的标签（「书籍」）命中
 * 的行也保留（R264 P2-1）。零命中放宽路径必须与窗口路径同走这一层，两套
 * 口径不得在同一条答案里对撞。 */
export function filterSingleCharTopicRows<T extends Pick<NoteRow, "title" | "content" | "tags" | "is_sensitive">>(
  rows: T[],
  terms: string[]
): T[] {
  const singles = terms.filter((t) => /^[\u4e00-\u9fa5]$/.test(t));
  if (singles.length === 0) return rows;
  const multi = terms.filter((t) => !singles.includes(t));
  return rows.filter((n) => {
    const hay = `${n.title ?? ""}\n${n.is_sensitive ? "" : n.content}\n${n.tags ?? ""}`;
    return (
      multi.some((t) => hay.includes(t)) ||
      singles.some((c) => hitsSingleCharTopic(hay, c) || tagHitsSingleCharTopic(n.tags, c))
    );
  });
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
export function buildFinanceFailClosedAnswer(stats: FinanceStats, phrase: string | null, futureExcluded = 0): string {
  return (
    "这个合计问题带有额外限定条件，暂不支持按限定条件精确合计；为避免估算出错（尤其多币种不能直接相加），我不做心算合计。\n\n" +
    `${buildFinanceAggAnswer(stats, phrase, null, futureExcluded)}\n\n` +
    "如需细看某一项，可在时间流搜索关键词逐条查看，或到「报告」页查看周报/月报的分类统计。"
  );
}

/** 时间窗折算天数（含起始日，截到 now）：用于「平均每天花多少」日均口径。 */
export function timeRangeAvgDays(range: TimeRange | null, now: Date = new Date()): number | null {
  if (!range?.start) return null;
  const startMs = Date.parse(range.start.replace(" ", "T") + "Z");
  const endMs = Math.min(range.end ? Date.parse(range.end.replace(" ", "T") + "Z") : Infinity, now.getTime());
  if (!Number.isFinite(startMs) || !(endMs > startMs)) return null;
  return Math.max(1, Math.ceil((endMs - startMs) / 86_400_000));
}

/** 财务聚合的「平均每天」限定（R252 P3-5）：总额 ÷ 窗口天数，纯 SQL 口径。 */
export const FINANCE_AVG_PER_DAY_RE = /平均每天|每天平均|日均/;

/** Deterministic answer for finance aggregate questions, built from financeStats (report口径). */
export function buildFinanceAggAnswer(
  stats: FinanceStats,
  phrase: string | null,
  avgDays: number | null = null,
  // R304 P1（audit-r303 §10）：窗内全是未来日期的预记时，「没有记账记录」
  // 与同答案里「另有 N 笔被排除」字面矛盾，也与周报（按记录所在周期）冲突。
  // 只收紧措辞为「没有**已发生**的记账」，口径本身不变。
  futureExcluded = 0
): string {
  const scope = phrase ?? "全部笔记";
  if (stats.expenseCount === 0 && stats.incomeCount === 0) {
    const transferNote = stats.transferCount > 0 ? `另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支。` : "";
    const head = futureExcluded > 0 ? `${scope}没有已发生的记账记录` : `${scope}没有记账记录`;
    return `${head}（支出/收入均为 0 笔）。${transferNote}${financeCaliberNote(phrase)}`;
  }
  const lines = Object.entries(stats.totals).map(
    ([cur, t]) =>
      `- ${cur}：支出 ${formatAmount(t.expense, cur)}，收入 ${formatAmount(t.income, cur)}，结余 ${formatAmount(t.income - t.expense, cur)}`
  );
  let md = `${scope}共记录 ${stats.expenseCount} 笔支出、${stats.incomeCount} 笔收入。\n${lines.join("\n")}`;
  if (avgDays) {
    // 日均：总额 ÷ 窗口天数（窗口截到当前时刻，含起始日）
    const avgParts = Object.entries(stats.totals)
      .map(([cur, t]) => {
        const seg: string[] = [];
        if (t.expense > 0) seg.push(`支出 ${formatAmount(Math.round((t.expense / avgDays) * 100) / 100, cur)}`);
        if (stats.incomeCount > 0 && t.income > 0) seg.push(`收入 ${formatAmount(Math.round((t.income / avgDays) * 100) / 100, cur)}`);
        return seg.join("、");
      })
      .filter(Boolean);
    if (avgParts.length > 0) md += `\n按 ${avgDays} 天折算，平均每天${avgParts.join("；")}。`;
    // R268（audit-r267 P3-2）：只覆盖 1 天时日均=单日总额，如实提示参考意义
    if (avgParts.length > 0 && avgDays === 1) md += `（记录仅覆盖 1 天，日均参考意义有限。）`;
  }
  if (stats.unknownAmount > 0) md += `\n（另有 ${stats.unknownAmount} 笔未识别出金额，未计入合计。）`;
  if (stats.transferCount > 0) md += `\n（另有 ${stats.transferCount} 笔资金往来（内转/提现/借还），不计入收支合计。）`;
  md += financeCaliberNote(phrase);
  return md;
}

/**
 * 财务子集零命中答复（R252 P2-1，audit-r251 §3）：带时间窗（显式或继承）时
 * 必须回显生效窗口——否则多轮里答复语义等价于「全库没有这笔记录」；并主动
 * 给出放宽路径（去掉时间限制后的精确合计）。无窗口时保持原措辞不变。
 */
export function buildFinanceSubsetZeroHitAnswer(
  terms: string[],
  range: TimeRange | null,
  relaxed: FinanceStats | null
): string {
  const kw = terms.join("、");
  const retryHint = "如果你的记录用了别的说法（比如具体商品/商家名），换个关键词再问试试。";
  if (!range) {
    return `按关键词「${kw}」精确匹配（标题/正文/标签）没有找到记账记录；为避免估算出错，我不做心算合计。${retryHint}`;
  }
  const span = timeRangeDisplay(range);
  const scope = range.phrase ? `${range.phrase}（${span}）` : span;
  const head = `在${scope}内按关键词「${kw}」精确匹配（标题/正文/标签）没有找到记账记录；为避免估算出错，我不做心算合计。`;
  if (relaxed && (relaxed.expenseCount > 0 || relaxed.incomeCount > 0)) {
    // 注：relaxed 必须是与窗口路径同一过滤口径（filterSingleCharTopicRows）后的
    // 统计，否则同一条答案里会出现「今年没找到、去掉时间限制又有」的自相矛盾
    //（audit-r263 §2.3）。
    const totalParts = Object.entries(relaxed.totals)
      .map(([cur, t]) => {
        const seg: string[] = [];
        if (t.expense > 0) seg.push(`支出 ${formatAmount(t.expense, cur)}`);
        if (t.income > 0) seg.push(`收入 ${formatAmount(t.income, cur)}`);
        return seg.join("、");
      })
      .filter(Boolean);
    const count = `${relaxed.expenseCount} 笔支出${relaxed.incomeCount > 0 ? `、${relaxed.incomeCount} 笔收入` : ""}`;
    return `${head}\n去掉时间限制后共有 ${count}（${totalParts.join("；")}），如需全部时间范围的明细，可在时间流搜索该关键词逐条查看。`;
  }
  // 不作全库否定断言（R264 P2-1，audit-r263：「看了电影」字面匹配不到「看电影」
  // 时说「也没找到」是无依据否定）：只陈述关键词字面匹配结果，不断言没有相关记录。
  return `${head}去掉时间限制后按这个关键词的字面匹配也没有匹配到（说法不同的记录可能匹配不到，不代表一定没有相关记录）。${retryHint}`;
}

/** True when a note's created_at (UTC sql string) falls inside the range. */
export function inTimeRange(createdAt: string, range: TimeRange): boolean {
  if (range.start && createdAt < range.start) return false;
  if (range.end && createdAt >= range.end) return false;
  return true;
}

/**
 * R290 P1（audit-r289 §财务时间窗）：事后补记的记账，正文里写的事件日期
 * （「3月8日买了打印机」）才是用户心智里的记账时间——时间窗只认 created_at
 * 会把这类最自然的问法整窗拒答。本组辅助把「正文事件时间（无则回退记录
 * 时间）」作为时间窗的有效时间：
 *  - noteEventTime：从标题+正文抽取首个明确日期（YYYY-MM-DD / YYYY年M月D日 /
 *    M月D日(号) / M月上·中·下旬），无年份时按记录时间就近推断（事件不晚于
 *    补记太多：得出的日期若比记录时间晚 60 天以上则回退上一年）；返回该日
 *    上海正午的 UTC sql 串（旬取 5/15/25 日代表日）。
 *  - widenTimeRangeForEvents：SQL 侧放宽窗（±400 天）粗取候选行，精筛在
 *    TS 侧按有效时间做——D1 无法解析正文中文日期。
 *  - inEventTimeRange：有效时间 ∈ 窗口。
 */
export function noteEventTime(note: Pick<NoteRow, "title" | "content" | "created_at">): string | null {
  const text = `${note.title ?? ""}\n${note.content}`.slice(0, 2000);
  let y: number | null = null;
  let mo: number | null = null;
  let d: number | null = null;
  let m: RegExpMatchArray | null;
  // 中文正文里日期常带空格（「3 月 8 日」是仓库自身文案风格）：各段之间允许空白，
  // 否则最自然的写法整条抽不出事件日期，时间窗又退回记录时间（R290 生产实测漏面）。
  if ((m = text.match(/(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?号?/))) {
    [y, mo, d] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  } else if ((m = text.match(/(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    [mo, d] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  } else if ((m = text.match(/(?<![\d.])(\d{1,2})\s*月\s*(上|中|下)旬/))) {
    mo = parseInt(m[1], 10);
    d = m[2] === "上" ? 5 : m[2] === "中" ? 15 : 25;
  } else {
    return null;
  }
  if (mo === null || d === null || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const createdMs = Date.parse(note.created_at.replace(" ", "T") + "Z");
  if (Number.isNaN(createdMs)) return null;
  const shCreated = new Date(createdMs + SH_OFFSET_MS);
  if (y === null) {
    y = shCreated.getUTCFullYear();
    // 无年份日期按「事件不晚于补记太多」就近取年：比记录时间晚 60 天以上视为去年的事
    if (Date.UTC(y, mo - 1, d) - Date.UTC(y, shCreated.getUTCMonth(), shCreated.getUTCDate()) > 60 * 86400_000) y -= 1;
  }
  if (y < 2000 || y > 2100) return null;
  // 该日上海正午（窗口边界都是上海零点，正午稳在当日内）
  return toUtcSql(new Date(Date.UTC(y, mo - 1, d, 12) - SH_OFFSET_MS));
}

const EVENT_WIDEN_MS = 400 * 86400_000;

/** SQL 侧粗取窗：按记录时间 ±400 天放宽，精筛交给 inEventTimeRange。 */
export function widenTimeRangeForEvents(range: TimeRange): TimeRange {
  const shift = (s: string | null, ms: number) => (s ? toUtcSql(new Date(Date.parse(s.replace(" ", "T") + "Z") + ms)) : null);
  return { start: shift(range.start, -EVENT_WIDEN_MS), end: shift(range.end, EVENT_WIDEN_MS), phrase: range.phrase };
}

/**
 * 有效时间（正文事件时间，无则记录时间）∈ 窗口。
 * R298 P1-1：当期窗（excludeFuture）的上界是「此刻」，未来日期的事件不属于当期。
 */
export function inEventTimeRange(
  note: Pick<NoteRow, "title" | "content" | "created_at">,
  range: TimeRange,
  now: Date = new Date()
): boolean {
  const t = noteEventTime(note) ?? note.created_at;
  if (!inTimeRange(t, range)) return false;
  return !(range.excludeFuture && isFutureEventTime(t, now));
}

/** 有效时间严格晚于此刻（未来记账：预记/计划性账目）。 */
function isFutureEventTime(utcSql: string, now: Date): boolean {
  const ms = Date.parse(utcSql.replace(" ", "T") + "Z");
  return Number.isFinite(ms) && ms > now.getTime();
}

/** 当期窗内被排除的未来事件（仅用于披露笔数，不计入合计）。 */
export function futureEventNotes<T extends EventTimeNote>(
  rows: T[],
  range: TimeRange | null | undefined,
  now: Date = new Date()
): T[] {
  if (!range?.excludeFuture) return [];
  return rows.filter((n) => {
    const t = noteEventTime(n) ?? n.created_at;
    return inTimeRange(t, { ...range, excludeFuture: false }) && isFutureEventTime(t, now);
  });
}

export type EventTimeNote = Pick<NoteRow, "title" | "content" | "created_at">;

export interface EventTimeWindow {
  /** SQL 侧粗取窗（放宽 ±400 天）；null 表示问题不带时间限定。 */
  readonly sql: TimeRange | null;
  /** SQL 条件统一拼装：调用点不得再手写 created_at 边界。 */
  applySql(conds: string[], binds: unknown[]): void;
  /** TS 侧精筛：有效时间（正文事件时间，无则记录时间）∈ 原窗。 */
  keep<T extends EventTimeNote>(rows: T[]): T[];
  /** 精筛后的条数（计数口径与 keep 完全一致）。 */
  count(rows: EventTimeNote[]): number;
  /** R298 P1-1：当期窗内被排除的「未来日期」笔数（供披露，不计入合计）。 */
  futureExcluded(rows: EventTimeNote[]): number;
}

/**
 * 时间窗筛选的唯一接入点（R292 P1-2，audit-r291 §财务时间窗）：所有
 * 时间窗/财务/枚举/关键词路径必须经由本函数取「SQL 粗取窗 + TS 精筛」
 * 成对使用，事件时间口径只在这里接入一次，禁止调用点再散点组合
 * widenTimeRangeForEvents / inEventTimeRange / inTimeRange(created_at)。
 */
export function eventTimeWindow(range: TimeRange | null | undefined): EventTimeWindow {
  const r = range ?? null;
  const wide = r ? widenTimeRangeForEvents(r) : null;
  return {
    sql: wide,
    applySql(conds: string[], binds: unknown[]) {
      if (wide?.start) {
        conds.push("created_at >= ?");
        binds.push(wide.start);
      }
      if (wide?.end) {
        conds.push("created_at < ?");
        binds.push(wide.end);
      }
    },
    keep<T extends EventTimeNote>(rows: T[]): T[] {
      return r ? rows.filter((n) => inEventTimeRange(n, r)) : rows;
    },
    count(rows: EventTimeNote[]): number {
      return this.keep(rows).length;
    },
    futureExcluded(rows: EventTimeNote[]): number {
      return futureEventNotes(rows, r).length;
    },
  };
}

/** UTC sql 串 → 上海本地日期 YYYY-MM-DD（endExclusive 时取前一刻所在日）。 */
function shDate(utcSql: string, endExclusive = false): string {
  const t = Date.parse(utcSql.replace(" ", "T") + "Z") + SH_OFFSET_MS - (endExclusive ? 1 : 0);
  return new Date(t).toISOString().slice(0, 10);
}

/** 时间窗的上海本地日期区间展示（「2026-08-10 至 2026-08-16」）。 */
export function timeRangeDisplay(range: TimeRange): string {
  const s = range.start ? shDate(range.start) : null;
  const e = range.end ? shDate(range.end, true) : null;
  if (s && e) return s === e ? s : `${s} 至 ${e}`;
  if (s) return `${s} 至今`;
  if (e) return `截至 ${e}`;
  return "";
}

/**
 * 时间窗确定性拒答（R244 P2 F-1，audit-r243）：问题限定了时间范围而窗口内
 * 零召回、只有范围外的相近笔记时，绝不把范围外片段交给 LLM 兜底生成——
 * 生成层对时间约束的遵守不可靠（R243 实测 6 跑 4 次把 7 月的出差答成
 * 「上周去了成都」）。确定性短路：如实说该时间范围内没有记录，范围外
 * 命中只作为标注了日期的参考列出，时间对不上这一点由代码说死。
 */
export function buildTimeWindowNoAnswerResponse(
  range: TimeRange,
  outOfRange: Pick<NoteRow, "id" | "title" | "content" | "created_at">[]
): { answer: string; references: { index: number; note_id: string }[] } {
  const span = timeRangeDisplay(range);
  const head = `${range.phrase}（${span}）范围内没有找到相关记录。`;
  if (outOfRange.length === 0) return { answer: head, references: [] };
  const top = outOfRange.slice(0, 3);
  const lines = top.map((n, i) => {
    return `[${i + 1}]（${shDate(n.created_at)}）${safeSuggestionLabel(n)}`;
  });
  return {
    answer: `${head}以下 ${top.length} 条相近的记录不在这个时间范围内，仅供参考：\n${lines.join("\n")}`,
    references: top.map((n, i) => ({ index: i + 1, note_id: n.id })),
  };
}

/**
 * Relation/follow-up wording whose answer usually spans two notes (多跳：首轮
 * 命中的笔记 + 与它因果/对应的第二跳笔记)。Gates the second-pass seeded
 * semantic recall in /api/ask so single-hop questions pay no extra latency.
 */
export const MULTI_HOP_RE = /关系|关联|依据|后来|进展|着落|落地|来龙去脉|脉络|演化|一体|同一|对得上|接上|呼应|前提|支撑/;

/** Cosine similarity below which a semantic-only recall hit is too weak to appear as a citation. */
export const ASK_CITATION_MIN_SCORE = 0.55;

// ---- 逐字复述引证补全（R262，audit-r261 P2-5）----
// 答案正文逐字复述了某条召回笔记的内容（≥VERBATIM_CITE_MIN_LEN 连续字符
// 重叠）却没把它列入引用时，把该笔记增补进 references。只增补、不改写答案
// 文本，与多跳引证补全同一口径。弱语义命中不补（保持 weak 不出现在引用的
// 既有约束）。

const VERBATIM_CITE_MIN_LEN = 8;
const VERBATIM_NONWORD_RE = /[^\p{L}\p{N}]+/gu;

export function verbatimUncitedSourceIds(
  answer: string,
  notes: readonly { id: string; content: string }[],
  citedIds: ReadonlySet<string>,
  weakIds: ReadonlySet<string>
): string[] {
  const a = answer.replace(VERBATIM_NONWORD_RE, "");
  if (a.length < VERBATIM_CITE_MIN_LEN) return [];
  const out: string[] = [];
  for (const n of notes) {
    if (citedIds.has(n.id) || weakIds.has(n.id)) continue;
    const c = n.content.replace(VERBATIM_NONWORD_RE, "");
    let hit = false;
    for (let i = 0; i + VERBATIM_CITE_MIN_LEN <= c.length && !hit; i += 1) {
      if (a.includes(c.slice(i, i + VERBATIM_CITE_MIN_LEN))) hit = true;
    }
    if (hit) out.push(n.id);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 依据/为什么类问题（R260 P2/q31）：答案需要引用「原因笔记 + 结果笔记」两条以上
 * 支撑片段，但候选序里语义强命中常被零分的关键词/图谱补位片段隔开（q31 实测
 * cafe2 语义 0.72 却排第 9），模型只从头部引用导致十跑 6/10。此类问题按语义
 * 分数把强命中重排到头部（只重排不增删，召回集合不变、不影响其他问题族）。
 */
export const BASIS_INTENT_RE = /为什么|依据|理由|原因|根据/;

/**
 * Stable rerank for basis-intent questions: strong semantic hits (score >=
 * minScore) move to the head in score order; everything else keeps its
 * relative order behind them. Pure reorder — no note enters or leaves.
 */
export function rerankBasisCandidates<T extends { id: string }>(
  notes: T[],
  score: Map<string, number>,
  minScore = ASK_CITATION_MIN_SCORE
): T[] {
  const strong = notes.filter((n) => (score.get(n.id) ?? 0) >= minScore);
  if (strong.length < 2 || strong.length === notes.length) return notes;
  strong.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
  return [...strong, ...notes.filter((n) => (score.get(n.id) ?? 0) < minScore)];
}

/**
 * Cosine similarity floor for the "相近的记录" suggestions attached to a 没找到
 * answer: below this the note is essentially unrelated (宁缺毋滥) and only
 * erodes trust when suggested.
 */
export const ASK_SUGGESTION_MIN_SCORE = 0.4;

/**
 * 主题词单独向量 vs 笔记向量的建议门槛（R268）：问句整句向量会被「买过/
 * 花了」这类动词带高（「买过汽车吗」擦到买书笔记 ≥0.5），主题词单独比对
 * 才分得开——bge-m3 实测：汽车 vs 买书笔记 ≤0.418，读物/书上 vs 买书笔记
 * ≥0.486，取中点 0.45。低于此线的笔记与问句主题无关，不当建议（宁缺毋滥）。
 */
export const ASK_SUGGESTION_TOPIC_MIN_SCORE = 0.45;

const CITE_RE = /[\[［](\d{1,2})[\]］]/g;

// 引用导言后面的 [n] 被剔除后会留下「参见 ，」这种空位；把悬空的导言词、
// 空括号和叠在一起的标点一并清掉，保证答案文本不出现断尾引用格式。
const DANGLING_LEADIN_RE = /(?:另?可?参见|详见|根据|结合)[\s　]*(?=$|[，。；、！？,.;!?)）\]】])/g;
export function cleanDanglingCitations(s: string): string {
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

/**
 * 隔离来源归因补全（R308 P1-1）：生成侧隔离（护栏/审计剥段）后，被剥掉那段
 * 所引的笔记会随 reconcileAskCitations 一起从 references 消失，横幅无处可指、
 * 「原文可在引用的笔记卡片中查看」也落空。把护栏前答案点到、护栏后不再点到、
 * 且不在 references 里的笔记（其次数据面判危的强召回笔记）追加进 references，
 * 返回它们的新序号作为 isolated_refs。只增补、不改写答案文本。
 */
export function attachIsolatedSources(
  references: { index: number; note_id: string }[],
  preGuardAnswer: string,
  postGuardAnswer: string,
  noteIds: string[],
  flaggedStrongIds: readonly string[]
): number[] {
  const present = new Set(references.map((r) => r.note_id));
  const idAt = (m: RegExpMatchArray): string | null => {
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= noteIds.length ? noteIds[n - 1] : null;
  };
  const stillCited = new Set([...postGuardAnswer.matchAll(CITE_RE)].map(idAt));
  const dropped: string[] = [];
  for (const m of preGuardAnswer.matchAll(CITE_RE)) {
    const id = idAt(m);
    if (id && !stillCited.has(id) && !present.has(id) && !dropped.includes(id)) dropped.push(id);
  }
  const add = dropped.length > 0 ? dropped : flaggedStrongIds.filter((id) => !present.has(id)).slice(0, 2);
  const out: number[] = [];
  for (const id of add) {
    const index = references.length + 1;
    references.push({ index, note_id: id });
    out.push(index);
  }
  return out;
}

const REFUSAL_PHRASE_RE = /没有?找到|没有相关|没有记录|未找到|找不到|没记过|没有这方面|没有笔记|没有?提到|未提及|没有提及/;

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
// 结余句式（还剩/剩余/余额/结余＋裸数字）同样是金额断言（R232 P3-1，
// audit-r231 §4：库内无余额事实，模型用 500+100−45 推算出「还剩 555」
// 当事实输出，无币种单位时逃过本剥除）；算式形态（「还剩 500 - 45 = 455」，
// R232 生产复测：结余词与结果数字间隔着算式，不命中裸数字分支）取
// 等号后的结果数校验。
// 通用算式形态（R234 P2-2，audit-r233 §P2-2：「所以花费了 60 * 2 = 120」——
// 无结余词、无币种单位，逃过上述全部分支）：答案里凡出现「数字 运算符 数字
// … = 数字」的加减乘除算式，等号后的结果数即模型自行心算的产物，一律取
// 结果数做无来源校验，与结余算式共用同一剥除管道。
const ANSWER_AMOUNT_RE =
  /[¥￥$€£]\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:元|块钱?|人民币|美元|美金|日元|欧元|英镑|港[币元]|韩元|rmb|cny|usd|jpy|eur|gbp|hkd|krw)|(?:还剩下?|剩余|余额|结余)[^。！？!?\n]{0,40}?[=＝]\s*(\d[\d,]*(?:\.\d+)?)|(?:还剩下?|剩余|余额|结余)[约为是有应该大概：:\s]*(\d[\d,]*(?:\.\d+)?)|\d[\d,]*(?:\.\d+)?(?:\s*[+＋\-−–*×✕/÷]\s*\d[\d,]*(?:\.\d+)?)+\s*[=＝]\s*(\d[\d,]*(?:\.\d+)?)/gi;

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
        const num = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
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

/** 模型退化乱码（同词循环、同片段连续重复）：不能当答案下发。 */
export function isDegenerateAnswer(answer: string): boolean {
  const text = answer.trim();
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length >= 12) {
    const uniq = new Set(toks.map((t) => t.toLowerCase().replace(/[.,;:!?。，！？]/g, "")));
    if (uniq.size / toks.length < 0.25) return true;
  }
  const m = /(.{2,8}?)\1{5,}/s.exec(text);
  return m !== null && m[0].length >= 30 && m[0].length * 2 >= text.length;
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
  if (sentences.length === 1) return true;
  // 多句全为否认（「没找到。 [1] 中没有提到……」）同样是拒答：任一句引入了
  // 非否认内容才算正常答案
  return sentences.every((s) => REFUSAL_PHRASE_RE.test(s));
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
export const CREDENTIAL_Q_RE = /密码|口令|私钥|助记词|恢复码|密钥|门禁码|passwords?|passphrase|secret key|pin\s?码/i;

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
/**
 * R300 P0-1（本地矩阵 c02/n08/n11，【实测确证】）：拒答/无召回路径的
 * 「相近的记录」标签直接取笔记正文前 40 字，不经最终出口闭合——载体把
 * 远端地址/外传指令写在开头时，地址与指令随建议行原样出关。标签含远端
 * 地址形态或危险执行迹象时退到标题，标题仍不安全则给不含原文的占位提示。
 */
export const HELD_SUGGESTION_LABEL = "（该笔记含被隔离内容，请在笔记卡片中查看）";
/** 标签只因含外部链接而不回显（资料面自身完全良性）：不是隔离，不置 instruction_isolated。 */
export const LINKED_SUGGESTION_LABEL = "（该笔记含外部链接，请在笔记卡片中查看）";

export function safeSuggestionLabel(n: Pick<NoteRow, "title" | "content">): string {
  const unsafe = (t: string): boolean =>
    t.trim().length > 0 &&
    (remoteEndpointForms(t, { includeEmails: true }).length > 0 ||
      execDegradedTraceReason(t) !== null ||
      // 风险行为祈使句（外传/导航/口令，跨语言）：推荐标签没有「用户要求回显」
      // 的语境，与最终出口同一判据剪除（R270-23 韩语外传句正是从这里出关）。
      scrubUnsolicitedConduct(t, "", [], "") !== t ||
      !dataSurfaceFullyBenign(t, [t]));
  // 不回显的标签是「隔离」还是「仅含链接」：资料面自身带危险执行/外传/读者指令
  // 信号才算隔离；纯导航 URL/邮箱/裸域名的良性笔记只是不在答案区转写链接。
  const dangerous = (t: string): boolean =>
    t.trim().length > 0 && (execDegradedTraceReason(t) !== null || !dataSurfaceFullyBenign(t, [t]));
  const clip = (t: string) => (t ?? "").replace(/\s+/g, " ").slice(0, 40);
  // 截断本身会切掉动作词（`… base64 解码` | `… curl 取回` 断在 40 字），使危险
  // 判据在片段上失效——因此整条原文与截断片段都要过判，任一不安全即不回显。
  const safe = (t: string): boolean => !unsafe(t) && !unsafe(clip(t));
  const source = n.title || n.content;
  if (safe(source)) return clip(source);
  const title = n.title ?? "";
  if (title.trim() && safe(title)) return clip(title);
  const content = n.content ?? "";
  return [source, clip(source), title, clip(title), content].some(dangerous)
    ? HELD_SUGGESTION_LABEL
    : LINKED_SUGGESTION_LABEL;
}

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
  mode: "no_recall" | "not_in_notes" = "no_recall",
  missingTerm: string | null = null
): {
  answer: string;
  references: { index: number; note_id: string }[];
  /** 任一建议标签因含危险/外传内容而退到占位提示（响应应置 instruction_isolated）。 */
  held: boolean;
} {
  if (suggestions.length === 0) {
    if (missingTerm) {
      return {
        answer: `笔记里没有提到与「${missingTerm}」相关的信息。换个说法（补充关键词或时间，如「上个月」「关于XX」）再试试。`,
        references: [],
        held: false,
      };
    }
    return {
      answer: `${NO_ANSWER_TEXT}换个说法（补充关键词或时间，如「上个月」「关于XX」）再试试。`,
      references: [],
      held: false,
    };
  }
  const labels = suggestions.slice(0, 3).map((n) => safeSuggestionLabel(n));
  const held = labels.some((l) => l === HELD_SUGGESTION_LABEL);
  const lines = labels.map((l, i) => `[${i + 1}] ${l}`);
  const lead =
    mode === "not_in_notes"
      ? missingTerm
        ? `找到了相近的记录，但里面没有提到与「${missingTerm}」相关的信息：`
        : "找到了相关的笔记，但里面没有提到你问的这个信息："
      : `${NO_ANSWER_TEXT}以下是几条相近的记录，可能是你想找的：`;
  return {
    answer: `${lead}\n${lines.join("\n")}`,
    references: suggestions.slice(0, 3).map((n, i) => ({ index: i + 1, note_id: n.id })),
    held,
  };
}
