import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";
import { DEFAULT_TZ, loadUserTz, tzOffsetMinutes, tzSqlModifier, zonedDate } from "./triage";
import { localDateOf, parseCreatedAt } from "./stats";

export type ReviewKind = "year_ago" | "month_ago" | "revisit" | "recurring_theme" | "pending_todo";

/** Max review items generated per user per day (first is the "one" pushed; extras feed 翻下一条). */
export const MAX_REVIEW_ITEMS = 3;

export const KIND_LABEL: Record<ReviewKind, string> = {
  year_ago: "一年前的今天",
  month_ago: "一个月前的今天",
  revisit: "值得回看",
  recurring_theme: "反复出现的主题",
  pending_todo: "悬置的待办",
};

const FALLBACK_COMMENT: Record<ReviewKind, string> = {
  year_ago: "一年前的今天你记下了它，看看当时的想法现在应验了吗？",
  month_ago: "一个月前的今天记下的碎念，回头看看有什么新的想法。",
  revisit: "这条记了很久没再翻过，也许正是重新审视它的好时机。",
  recurring_theme: "近两周你反复记到这个主题，也许它值得认真展开一次。",
  pending_todo: "这条待办快到期了（或已过期），要不要现在处理掉它？",
};

/** Current date in Asia/Shanghai as YYYY-MM-DD. */
export function shanghaiDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** A stored UTC created_at rendered as the user's local YYYY-MM-DD. */
export function localReviewDate(createdAt: string, tzOffsetMin: number): string {
  const ms = parseCreatedAt(createdAt);
  return Number.isNaN(ms) ? createdAt.slice(0, 10) : localDateOf(ms, tzOffsetMin);
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

async function notesOnLocalDay(env: Env, userId: string, dayYmd: string, limit: number, tzModifier: string): Promise<NoteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL
       AND datetime(created_at, ?) >= datetime(? || ' 00:00:00')
       AND datetime(created_at, ?) <= datetime(? || ' 23:59:59')
     ORDER BY length(content) DESC LIMIT ?`
  )
    .bind(userId, tzModifier, dayYmd, tzModifier, dayYmd, limit)
    .all<NoteRow>();
  return results ?? [];
}

/** Long-untouched high-value fragments: older ideas/collections with substance, not recently updated. */
async function revisitCandidates(env: Env, userId: string, exclude: string[], limit: number): Promise<NoteRow[]> {
  const ph = exclude.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL
       AND category IN ('idea', 'collect')
       AND length(content) >= 20
       AND created_at < datetime('now', '-14 days')
       AND updated_at < datetime('now', '-7 days')
       AND id NOT IN (SELECT note_id FROM daily_reviews WHERE user_id = ? AND review_date >= date('now', '-30 days'))
       ${exclude.length > 0 ? `AND id NOT IN (${ph})` : ""}
     ORDER BY RANDOM() LIMIT ?`
  )
    .bind(userId, userId, ...exclude, limit)
    .all<NoteRow>();
  return results ?? [];
}

/** 降级候选：任意 1 天前创建、有实质内容的非敏感笔记（不限分类），新账号也能尽快有回顾 */
async function relaxedCandidates(env: Env, userId: string, limit: number): Promise<NoteRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL
       AND length(content) >= 10
       AND created_at < datetime('now', '-1 day')
     ORDER BY RANDOM() LIMIT ?`
  )
    .bind(userId, limit)
    .all<NoteRow>();
  return results ?? [];
}

/** 近两周同一主题（线索）碎片 ≥3 条时，取该主题最新一条作为「反复出现的主题」洞察。 */
async function recurringThemeCandidate(env: Env, userId: string, exclude: string[]): Promise<NoteRow | null> {
  const hot = await env.DB.prepare(
    `SELECT thread_id, COUNT(*) AS n FROM notes
      WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND thread_id IS NOT NULL
        AND created_at >= datetime('now', '-14 days')
      GROUP BY thread_id HAVING n >= 3
      ORDER BY n DESC LIMIT 1`
  )
    .bind(userId)
    .first<{ thread_id: string; n: number }>();
  if (!hot) return null;
  const ph = exclude.map(() => "?").join(",");
  return await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND thread_id = ?
       ${exclude.length > 0 ? `AND id NOT IN (${ph})` : ""}
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(userId, hot.thread_id, ...exclude)
    .first<NoteRow>();
}

/** 临期（48h 内到期）或已过期、且未完成的待办，作为「悬置的待办」洞察。 */
async function pendingTodoCandidate(env: Env, userId: string, exclude: string[]): Promise<NoteRow | null> {
  const ph = exclude.map(() => "?").join(",");
  return await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL
       AND category = 'todo' AND (todo_done IS NULL OR todo_done = 0)
       AND todo_due IS NOT NULL AND datetime(todo_due) <= datetime('now', '+2 days')
       ${exclude.length > 0 ? `AND id NOT IN (${ph})` : ""}
     ORDER BY datetime(todo_due) ASC LIMIT 1`
  )
    .bind(userId, ...exclude)
    .first<NoteRow>();
}

async function reviewComment(env: Env, note: NoteRow, kind: ReviewKind, tzOffsetMin = 480): Promise<string> {
  const text = (
    await chatComplete(env, {
      temperature: 0.6,
      max_tokens: 120,
      timeout_ms: 15_000,
      messages: [
        {
          role: "system",
          content:
            "你是「碎念」回顾助手。用户会给你一条 TA 过去记下的笔记，请用一句话（30 字以内，中文，亲切自然）点评为什么这条值得现在回头看看。这句话必须点到笔记里的具体内容（引用其中的关键词、数字或提到的事），禁止输出「值得回顾」「优化工作流程」这类不看内容也能说的空话。只输出这一句话，不要引号和前缀。",
        },
        {
          role: "user",
          content: `记录时间：${localReviewDate(note.created_at, tzOffsetMin)}（${KIND_LABEL[kind]}）\n内容：${(note.title || note.content).slice(0, 300)}`,
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
 * long-untouched high-value ideas. Sensitive notes never enter reviews,
 * except due-driven pending todos (D1-R118)：加密待办的截止提醒必须生效，
 * 展示与点评只用明文 title/占位符，密文内容绝不出库。
 */
export async function generateDailyReview(env: Env, userId: string, now: Date = new Date()): Promise<number> {
  return (await generateDailyReviewDetailed(env, userId, now)).count;
}

export interface DailyReviewGenResult {
  count: number;
  /** "generated" = new rows written; "already" = rows existed for today; "empty" = no material */
  outcome: "generated" | "already" | "empty";
}

export async function generateDailyReviewDetailed(
  env: Env,
  userId: string,
  now: Date = new Date()
): Promise<DailyReviewGenResult> {
  // 回顾的“今天”与周年/月年的日边界按用户时区偏好计算（R107 P2-2）
  const tz = await loadUserTz(env, userId).catch(() => DEFAULT_TZ);
  const tzModifier = tzSqlModifier(now, tz);
  const tzOffsetMin = tzOffsetMinutes(now, tz);
  const today = zonedDate(now, tz).iso;
  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM daily_reviews WHERE user_id = ? AND review_date = ?"
  )
    .bind(userId, today)
    .first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return { count: existing!.n, outcome: "already" };

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
  push(await notesOnLocalDay(env, userId, shiftDate(today, { years: 1 }), 2, tzModifier), "year_ago", 2);
  push(await notesOnLocalDay(env, userId, shiftDate(today, { months: 1 }), 2, tzModifier), "month_ago", 2);
  // 洞察轮换：按日期奇偶轮换「反复出现的主题」/「悬置的待办」优先级，每天至多 1 条
  if (picks.length < MAX_REVIEW_ITEMS) {
    const dayNum = parseInt(today.replace(/-/g, ""), 10);
    const order: ReviewKind[] = dayNum % 2 === 0 ? ["recurring_theme", "pending_todo"] : ["pending_todo", "recurring_theme"];
    for (const kind of order) {
      const cand =
        kind === "recurring_theme"
          ? await recurringThemeCandidate(env, userId, [...seen])
          : await pendingTodoCandidate(env, userId, [...seen]);
      if (cand) {
        push([cand], kind, 1);
        break;
      }
    }
  }
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
    return { count: 0, outcome: "empty" };
  }

  for (let i = 0; i < picks.length; i++) {
    const { note, kind } = picks[i];
    let comment = FALLBACK_COMMENT[kind];
    try {
      comment = await reviewComment(env, note, kind, tzOffsetMin);
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
  return { count: picks.length, outcome: "generated" };
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
  const tz = await loadUserTz(env, userId).catch(() => DEFAULT_TZ);
  const today = zonedDate(now, tz).iso;
  const query = () =>
    env.DB.prepare(
      `SELECT r.id AS review_id, r.kind, r.comment, n.*
         FROM daily_reviews r JOIN notes n ON n.id = r.note_id
        WHERE r.user_id = ? AND r.review_date = ?
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
  already: number;
  empty: number;
  failed: number;
}

export interface CronHeartbeat {
  job: string;
  last_run_at: string;
  source: string;
  stats: string | null;
}

/** Persist a per-job heartbeat row so "cron 没跑" is distinguishable from "跑了但无素材". */
export async function writeCronHeartbeat(env: Env, job: string, source: string, stats: unknown): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO cron_heartbeats (job, last_run_at, source, stats) VALUES (?, datetime('now'), ?, ?)
       ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at, source = excluded.source, stats = excluded.stats`
    )
      .bind(job, source, JSON.stringify(stats))
      .run();
  } catch (e) {
    console.error(`heartbeat write failed for job=${job}`, e);
  }
}

export async function readCronHeartbeats(env: Env, jobs: string[]): Promise<CronHeartbeat[]> {
  try {
    const ph = jobs.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT * FROM cron_heartbeats WHERE job IN (${ph})`)
      .bind(...jobs)
      .all<CronHeartbeat>();
    return results ?? [];
  } catch {
    return [];
  }
}

/** Daily cron: generate review items for all users; logs and persists a per-run summary. */
export async function generateAllDailyReviews(env: Env, source: "cron" | "admin" = "cron"): Promise<DailyReviewSweepStats> {
  const { results } = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
  const stats: DailyReviewSweepStats = { users: (results ?? []).length, generated: 0, already: 0, empty: 0, failed: 0 };
  for (const u of results ?? []) {
    try {
      const r = await generateDailyReviewDetailed(env, u.id);
      stats[r.outcome === "generated" ? "generated" : r.outcome === "already" ? "already" : "empty"]++;
    } catch (e) {
      // per-user failures shouldn't stop the sweep, but must be visible
      stats.failed++;
      console.error(`daily-review: generate failed for user=${u.id}`, e);
    }
  }
  console.log(
    `daily-review sweep (${source}): users=${stats.users} generated=${stats.generated} already=${stats.already} empty=${stats.empty} failed=${stats.failed}`
  );
  await writeCronHeartbeat(env, `daily_review:${source}`, source, stats);
  return stats;
}
