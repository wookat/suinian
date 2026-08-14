import type { Env } from "./types";

/** Sample notes (一键丢入示例) carry this tag and never enter stats. */
export const SAMPLE_TAG = "示例";
export const SAMPLE_TAG_LIKE = `%"${SAMPLE_TAG}"%`;

export interface DailyCount {
  date: string;
  count: number;
}

export interface StatsResponse {
  total_notes: number;
  thread_count: number;
  /** Distinct local-tz days with at least one note, across all history (not windowed). */
  active_days: number;
  daily: DailyCount[];
  streak: { current: number; longest: number };
  categories: { category: string; count: number }[];
  sources: { source: string; count: number }[];
  top_tags: { tag: string; count: number }[];
}

/** Clamp a tz offset (minutes east of UTC) to a sane range; default Asia/Shanghai. */
export function normalizeTzOffset(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return 480;
  return Math.max(-720, Math.min(840, n));
}

/** "YYYY-MM-DD" for a UTC instant shifted by tzOffset minutes. */
export function localDateOf(utcMs: number, tzOffset: number): string {
  return new Date(utcMs + tzOffset * 60_000).toISOString().slice(0, 10);
}

/** Parse a stored UTC "YYYY-MM-DD HH:MM:SS" (or ISO) creation time to ms; NaN on garbage. */
export function parseCreatedAt(v: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  return Date.parse(iso);
}

function addDays(iso: string, delta: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Current + longest run of consecutive days with at least one note.
 * The current streak also counts when today has no note yet but yesterday
 * does (the streak is still "alive").
 */
export function computeStreaks(days: Iterable<string>, today: string): { current: number; longest: number } {
  const set = new Set(days);
  const sorted = [...set].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }
  let anchor: string | null = set.has(today) ? today : set.has(addDays(today, -1)) ? addDays(today, -1) : null;
  let current = 0;
  while (anchor && set.has(anchor)) {
    current++;
    anchor = addDays(anchor, -1);
  }
  return { current, longest };
}

interface StatNoteRow {
  created_at: string;
  category: string | null;
  source: string;
  tags: string;
  is_sensitive: number;
}

/**
 * Aggregate dashboard stats from raw rows (pure, unit-testable). Sensitive
 * notes count toward totals/heatmap/streak/distributions, but their tags stay
 * out of top_tags so nothing content-derived leaks.
 */
export function aggregateStats(
  rows: StatNoteRow[],
  threadCount: number,
  opts: { days: number; tzOffset: number; now?: number; tag?: string; scopeDays?: number }
): StatsResponse {
  const { days, tzOffset } = opts;
  const today = localDateOf(opts.now ?? Date.now(), tzOffset);
  const since = addDays(today, -(days - 1));

  // 自定义洞察范围（时间×标签）：命中范围的行才参与全部统计。标签筛选时
  // 排除敏感笔记（它们的标签本就不对外暴露，按标签筛选会反推内容）。
  if (opts.tag || opts.scopeDays) {
    const scopeSince = opts.scopeDays ? addDays(today, -(opts.scopeDays - 1)) : null;
    rows = rows.filter((r) => {
      if (scopeSince) {
        const ms = parseCreatedAt(r.created_at);
        if (Number.isNaN(ms) || localDateOf(ms, tzOffset) < scopeSince) return false;
      }
      if (opts.tag) {
        if (r.is_sensitive) return false;
        try {
          const tags = JSON.parse(r.tags || "[]") as string[];
          if (!Array.isArray(tags) || !tags.includes(opts.tag)) return false;
        } catch {
          return false;
        }
      }
      return true;
    });
  }

  const dailyMap = new Map<string, number>();
  const catMap = new Map<string, number>();
  const srcMap = new Map<string, number>();
  const tagMap = new Map<string, number>();
  const allDays = new Set<string>();

  for (const r of rows) {
    const ms = parseCreatedAt(r.created_at);
    if (!Number.isNaN(ms)) {
      const d = localDateOf(ms, tzOffset);
      allDays.add(d);
      if (d >= since && d <= today) dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1);
    }
    catMap.set(r.category ?? "pending", (catMap.get(r.category ?? "pending") ?? 0) + 1);
    srcMap.set(r.source, (srcMap.get(r.source) ?? 0) + 1);
    if (!r.is_sensitive) {
      try {
        for (const t of JSON.parse(r.tags || "[]") as string[]) {
          if (typeof t === "string" && t && t !== SAMPLE_TAG) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        }
      } catch {
        /* ignore bad rows */
      }
    }
  }

  const byCount = <K extends string>(m: Map<string, number>, key: K) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, count]) => ({ [key]: k, count }) as Record<K, string> & { count: number });

  return {
    total_notes: rows.length,
    thread_count: threadCount,
    active_days: allDays.size,
    daily: [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
    streak: computeStreaks(allDays, today),
    categories: byCount(catMap, "category"),
    sources: byCount(srcMap, "source"),
    top_tags: byCount(tagMap, "tag").slice(0, 12),
  };
}

/** One-shot dashboard stats. Soft-deleted and #示例 sample notes never count. */
export async function buildStats(
  env: Env,
  userId: string,
  opts: { days: number; tzOffset: number; tag?: string; scopeDays?: number }
): Promise<StatsResponse> {
  const [notesRes, threadRes] = await Promise.all([
    env.DB.prepare(
      "SELECT created_at, category, source, tags, is_sensitive FROM notes WHERE user_id = ? AND deleted_at IS NULL AND tags NOT LIKE ?"
    )
      .bind(userId, SAMPLE_TAG_LIKE)
      .all<StatNoteRow>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM threads WHERE user_id = ?").bind(userId).first<{ c: number }>(),
  ]);
  return aggregateStats(notesRes.results ?? [], threadRes?.c ?? 0, opts);
}
