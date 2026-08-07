import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";

export type ReviewKind = "year_ago" | "month_ago" | "revisit";

export interface DailyReviewRow {
  id: string;
  user_id: string;
  review_date: string;
  note_id: string;
  kind: ReviewKind;
  comment: string | null;
  position: number;
  created_at: string;
}

/** Max review items generated per user per day (first is the "one" pushed; extras feed 翻下一条). */
export const MAX_REVIEW_ITEMS = 3;

export const KIND_LABEL: Record<ReviewKind, string> = {
  year_ago: "一年前的今天",
  month_ago: "一个月前的今天",
  revisit: "值得回看",
};

const FALLBACK_COMMENT: Record<ReviewKind, string> = {
  year_ago: "一年前的今天你记下了它，看看当时的想法现在应验了吗？",
  month_ago: "一个月前的今天记下的碎念，回头看看有什么新的想法。",
  revisit: "这条记了很久没再翻过，也许正是重新审视它的好时机。",
};

/** Current date in Asia/Shanghai as YYYY-MM-DD. */
export function shanghaiDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** The same calendar day shifted back by months/years (clamped by Date rollover). */
export function shiftDate(dateYmd: string, opts: { years?: number; months?: number }): string {
  const [y, m, d] = dateYmd.split("-").map((x) => parseInt(x, 10));
  const target = new Date(Date.UTC(y - (opts.years ?? 0), m - 1 - (opts.months ?? 0), d));
  // Date rollover (e.g. 03-31 minus 1 month -> 03-03) means the anchor day
  // doesn't exist in that month; treat it as "no anniversary" by returning
  // the clamped last day of the intended month instead of a rolled-over date.
  if (target.getUTCDate() !== d) {
    target.setUTCDate(0);
  }
  return target.toISOString().slice(0, 10);
}

async function notesOnShanghaiDay(env: Env, userId: string, dayYmd: string, limit: number): Promise<NoteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0
       AND datetime(created_at, '+8 hours') >= datetime(? || ' 00:00:00')
       AND datetime(created_at, '+8 hours') <= datetime(? || ' 23:59:59')
     ORDER BY length(content) DESC LIMIT ?`
  )
    .bind(userId, dayYmd, dayYmd, limit)
    .all<NoteRow>();
  return results ?? [];
}

/** Long-untouched high-value fragments: older ideas/collections with substance, not recently updated. */
async function revisitCandidates(env: Env, userId: string, exclude: string[], limit: number): Promise<NoteRow[]> {
  const ph = exclude.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0
       AND category IN ('idea', 'collect')
       AND length(content) >= 20
       AND created_at < datetime('now', '-14 days')
       AND updated_at < datetime('now', '-7 days')
       ${exclude.length > 0 ? `AND id NOT IN (${ph})` : ""}
     ORDER BY RANDOM() LIMIT ?`
  )
    .bind(userId, ...exclude, limit)
    .all<NoteRow>();
  return results ?? [];
}

/** 降级候选：任意 3 天前创建、有实质内容的非敏感笔记（不限分类） */
async function relaxedCandidates(env: Env, userId: string, limit: number): Promise<NoteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0
       AND length(content) >= 10
       AND created_at < datetime('now', '-3 days')
     ORDER BY RANDOM() LIMIT ?`
  )
    .bind(userId, limit)
    .all<NoteRow>();
  return results ?? [];
}

async function reviewComment(env: Env, note: NoteRow, kind: ReviewKind): Promise<string> {
  const text = (
    await chatComplete(env, {
      temperature: 0.6,
      max_tokens: 120,
      timeout_ms: 15_000,
      messages: [
        {
          role: "system",
          content:
            "你是「碎念」回顾助手。用户会给你一条 TA 过去记下的笔记，请用一句话（30 字以内，中文，亲切自然）点评为什么这条值得现在回头看看。只输出这一句话，不要引号和前缀。",
        },
        {
          role: "user",
          content: `记录时间：${note.created_at.slice(0, 10)}（${KIND_LABEL[kind]}）\n内容：${(note.title || note.content).slice(0, 300)}`,
        },
      ],
    })
  )?.trim();
  return text && text.length <= 80 ? text : FALLBACK_COMMENT[kind];
}

/**
 * Generate today's review items for one user (idempotent: existing rows for
 * the date are kept and the function returns without regenerating). Picks
 * "a year ago today" / "a month ago today" notes first, then fills with
 * long-untouched high-value ideas. Sensitive notes never enter reviews.
 */
export async function generateDailyReview(env: Env, userId: string, now: Date = new Date()): Promise<number> {
  const today = shanghaiDate(now);
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM daily_reviews WHERE user_id = ? AND review_date = ?"
  )
    .bind(userId, today)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return existing!.n;

  const picks: { note: NoteRow; kind: ReviewKind }[] = [];
  const seen = new Set<string>();
  const push = (rows: NoteRow[], kind: ReviewKind, max: number) => {
    for (const n of rows) {
      if (picks.length >= MAX_REVIEW_ITEMS || seen.has(n.id)) continue;
      if (picks.filter((p) => p.kind === kind).length >= max) continue;
      picks.push({ note: n, kind });
      seen.add(n.id);
    }
  };
  push(await notesOnShanghaiDay(env, userId, shiftDate(today, { years: 1 }), 2), "year_ago", 2);
  push(await notesOnShanghaiDay(env, userId, shiftDate(today, { months: 1 }), 2), "month_ago", 2);
  if (picks.length < MAX_REVIEW_ITEMS) {
    push(await revisitCandidates(env, userId, [...seen], MAX_REVIEW_ITEMS - picks.length), "revisit", MAX_REVIEW_ITEMS);
  }
  if (picks.length === 0) {
    // 降级选材：小数据量用户常常凑不齐严格条件（周年/月年无记录、
    // 想法/收藏不足 14 天），退而求其次取任意 3 天前的非敏感笔记
    push(await relaxedCandidates(env, userId, 1), "revisit", MAX_REVIEW_ITEMS);
  }
  if (picks.length === 0) {
    // 真正无可选素材（新用户/空账号）：明确不落库，仅记日志
    console.log(`daily-review: no material for user=${userId} date=${today}`);
    return 0;
  }

  for (let i = 0; i < picks.length; i++) {
    const { note, kind } = picks[i];
    let comment = FALLBACK_COMMENT[kind];
    try {
      comment = await reviewComment(env, note, kind);
    } catch {
      /* keep the fallback comment */
    }
    await env.DB.prepare(
      `INSERT INTO daily_reviews (id, user_id, review_date, note_id, kind, comment, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, review_date, note_id) DO NOTHING`
    )
      .bind(crypto.randomUUID(), userId, today, note.id, kind, comment, i)
      .run();
  }
  return picks.length;
}

export interface TodayReviewItem {
  id: string;
  kind: ReviewKind;
  kind_label: string;
  comment: string | null;
  note: NoteRow;
}

/**
 * Fetch today's review items (joined with live note rows); generates them
 * on demand when the daily cron hasn't run yet for this user.
 */
export async function getTodayReview(env: Env, userId: string, now: Date = new Date()): Promise<{ date: string; items: TodayReviewItem[] }> {
  const today = shanghaiDate(now);
  const query = () =>
    env.DB.prepare(
      `SELECT r.id AS review_id, r.kind, r.comment, n.*
         FROM daily_reviews r JOIN notes n ON n.id = r.note_id
        WHERE r.user_id = ? AND r.review_date = ? AND n.is_sensitive = 0
        ORDER BY r.position ASC`
    )
      .bind(userId, today)
      .all<NoteRow & { review_id: string; kind: ReviewKind; comment: string | null }>();

  let { results } = await query();
  if ((results ?? []).length === 0) {
    const n = await generateDailyReview(env, userId, now);
    if (n > 0) results = (await query()).results;
  }
  const items = (results ?? []).map((r) => {
    const { review_id, kind, comment, ...note } = r;
    return { id: review_id, kind, kind_label: KIND_LABEL[kind], comment, note: note as NoteRow };
  });
  return { date: today, items };
}

export interface DailyReviewSweepStats {
  users: number;
  generated: number;
  empty: number;
  failed: number;
}

/** Daily cron: generate review items for all users; logs a per-run summary. */
export async function generateAllDailyReviews(env: Env): Promise<DailyReviewSweepStats> {
  const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
  const stats: DailyReviewSweepStats = { users: (results ?? []).length, generated: 0, empty: 0, failed: 0 };
  for (const u of results ?? []) {
    try {
      const n = await generateDailyReview(env, u.id);
      if (n > 0) stats.generated++;
      else stats.empty++;
    } catch (e) {
      // per-user failures shouldn't stop the sweep, but must be visible
      stats.failed++;
      console.error(`daily-review: generate failed for user=${u.id}`, e);
    }
  }
  console.log(
    `daily-review sweep: users=${stats.users} generated=${stats.generated} empty=${stats.empty} failed=${stats.failed}`
  );
  return stats;
}
