/**
 * Web Push (VAPID) delivery + the two push sweeps (todo due reminders, daily
 * review). Payload encryption (RFC 8291 aes128gcm) and the VAPID ES256 JWT are
 * handled by @block65/webcrypto-web-push, which is pure WebCrypto and runs on
 * Cloudflare Workers (the classic `web-push` npm package needs Node crypto and
 * does not).
 */
import { buildPushPayload, type PushSubscription as WirePushSubscription } from "@block65/webcrypto-web-push";
import type { Env, NoteRow } from "./types";
import { getTodayReview, writeCronHeartbeat, shanghaiDate } from "./review";
import { DEFAULT_TZ, loadUserTz, tzOffsetString } from "./triage";

export interface PushSubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  tz: string | null;
  ua: string | null;
  created_at: string;
  last_ok_at: string | null;
}

/** What the service worker receives; `url` is the in-app path to open on click. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export function pushConfigured(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function vapid(env: Env) {
  return {
    subject: env.VAPID_SUBJECT || "mailto:admin@zalize.com",
    publicKey: env.VAPID_PUBLIC_KEY!,
    privateKey: env.VAPID_PRIVATE_KEY!,
  };
}

/**
 * Send one payload to one subscription. Returns "ok", "gone" (subscription
 * expired — row already deleted), or "error". Never throws.
 */
export async function sendPush(env: Env, sub: PushSubRow, payload: PushPayload): Promise<"ok" | "gone" | "error"> {
  const wire: WirePushSubscription = {
    endpoint: sub.endpoint,
    expirationTime: null,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  try {
    const init = await buildPushPayload({ data: JSON.stringify(payload), options: { ttl: 3600, urgency: "normal" } }, wire, vapid(env));
    const res = await fetch(sub.endpoint, init);
    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
      return "gone";
    }
    if (res.ok || res.status === 201) {
      await env.DB.prepare("UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?").bind(sub.id).run();
      return "ok";
    }
    console.error(`push send failed: status=${res.status} endpoint=${sub.endpoint.slice(0, 60)}`);
    return "error";
  } catch (e) {
    console.error("push send error", e);
    return "error";
  }
}

export async function userSubscriptions(env: Env, userId: string): Promise<PushSubRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<PushSubRow>();
  return results ?? [];
}

/** Send to every subscription of a user; returns how many deliveries succeeded. */
export async function sendPushToUser(env: Env, userId: string, payload: PushPayload): Promise<number> {
  const subs = await userSubscriptions(env, userId);
  let ok = 0;
  for (const s of subs) {
    if ((await sendPush(env, s, payload)) === "ok") ok++;
  }
  return ok;
}

/** Epoch ms of a local wall-clock time ("YYYY-MM-DDTHH:mm") in IANA timezone `tz`. */
function parseInTz(local: string, tz: string): number {
  let off = "+08:00";
  try {
    off = tzOffsetString(new Date(Date.parse(`${local}:00Z`)), tz);
  } catch {
    // invalid tz string: keep the Asia/Shanghai fallback
  }
  return Date.parse(`${local}:00${off}`);
}

/**
 * Due-time of a todo in epoch ms. `todo_due` is either a bare date
 * (YYYY-MM-DD, treated as 09:00 local in the user's timezone), a datetime
 * with a UTC offset, or a legacy offset-less datetime (user-local).
 */
export function todoDueEpochMs(due: string | null, tz: string = DEFAULT_TZ): number | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return parseInTz(`${due}T09:00`, tz);
  const m = due.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/);
  const t = m ? parseInTz(`${m[1]}T${m[2]}`, tz) : Date.parse(due);
  return Number.isNaN(t) ? null : t;
}

const REMINDER_LOOKBACK_MS = 24 * 3600 * 1000;

/** Lead time before a timed due at which the reminder fires. */
export const REMINDER_LEAD_MS = 30 * 60_000;

/**
 * When to remind for a todo: 30 minutes before a timed due, or 08:00 local
 * (user timezone) on the due day for bare dates (before the day's implicit
 * 09:00 due). Reminders are useful before the deadline, not after it.
 */
export function todoReminderEpochMs(due: string | null, tz: string = DEFAULT_TZ): number | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return parseInTz(`${due}T08:00`, tz);
  const t = todoDueEpochMs(due, tz);
  return t === null ? null : t - REMINDER_LEAD_MS;
}

export interface TodoReminderStats {
  candidates: number;
  reminded: number;
  delivered: number;
  skipped_pref: number;
  skipped_no_sub: number;
}

/**
 * Cron sweep: push a reminder for todos whose reminder time (ahead of the
 * due — see todoReminderEpochMs) has been reached within the last 24h and
 * which are unfinished and not yet reminded. Once a delivery channel exists
 * (preference on + at least one subscription), the todo is marked reminded
 * before delivery is attempted (at-most-once when anything lands); if every
 * delivery fails, the mark is released so the next cron retries within the
 * 24h lookback window. A user with no subscription keeps the reminder
 * unconsumed: it fires within the 24h lookback once they subscribe.
 */
export async function sweepTodoReminders(env: Env, now: Date = new Date()): Promise<TodoReminderStats> {
  const stats: TodoReminderStats = { candidates: 0, reminded: 0, delivered: 0, skipped_pref: 0, skipped_no_sub: 0 };
  if (!pushConfigured(env)) return stats;
  // push the due-date window into SQL (R109 P2-3): without it, a backlog of
  // stale or far-future todos could crowd the 200-row cap and starve the
  // actually-due ones. ±2 days around today covers every UTC offset plus the
  // 24h lookback; the exact per-timezone check stays in the filter below.
  const nowIso = now.toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes
      WHERE deleted_at IS NULL AND category = 'todo'
        AND (todo_done IS NULL OR todo_done = 0)
        AND todo_reminded_at IS NULL AND todo_due IS NOT NULL
        AND substr(todo_due, 1, 10) BETWEEN date(?, '-2 days') AND date(?, '+2 days')
      ORDER BY todo_due ASC LIMIT 200`
  )
    .bind(nowIso, nowIso)
    .all<NoteRow>();
  const nowMs = now.getTime();
  const tzCache = new Map<string, string>();
  const userTz = async (uid: string): Promise<string> => {
    if (!tzCache.has(uid)) tzCache.set(uid, await loadUserTz(env, uid));
    return tzCache.get(uid)!;
  };
  const dueRows: NoteRow[] = [];
  for (const n of results ?? []) {
    const t = todoReminderEpochMs(n.todo_due, await userTz(n.user_id));
    if (t !== null && t <= nowMs && t >= nowMs - REMINDER_LOOKBACK_MS) dueRows.push(n);
  }
  stats.candidates = dueRows.length;

  const subCache = new Map<string, PushSubRow[]>();
  const prefCache = new Map<string, boolean>();
  for (const n of dueRows) {
    if (!prefCache.has(n.user_id)) {
      const p = await env.DB.prepare("SELECT todo_reminder_push FROM user_preferences WHERE user_id = ?")
        .bind(n.user_id)
        .first<{ todo_reminder_push: number }>();
      prefCache.set(n.user_id, p ? p.todo_reminder_push === 1 : true);
    }
    if (!prefCache.get(n.user_id)) {
      // the user explicitly turned reminders off: consuming the slot is intended
      await env.DB.prepare("UPDATE notes SET todo_reminded_at = datetime('now') WHERE id = ?").bind(n.id).run();
      stats.reminded++;
      stats.skipped_pref++;
      continue;
    }
    if (!subCache.has(n.user_id)) subCache.set(n.user_id, await userSubscriptions(env, n.user_id));
    const subs = subCache.get(n.user_id)!;
    if (subs.length === 0) {
      // no delivery channel: leave todo_reminded_at unset so the reminder can
      // still fire once the user subscribes, instead of burning it silently
      stats.skipped_no_sub++;
      continue;
    }
    // mark before delivery: at-most-once even if delivery below fails midway
    await env.DB.prepare("UPDATE notes SET todo_reminded_at = datetime('now') WHERE id = ?").bind(n.id).run();
    stats.reminded++;
    let okCount = 0;
    let goneCount = 0;
    const label = n.is_sensitive ? "一条待办" : (n.title || n.content || "待办").slice(0, 60);
    const dueMs = todoDueEpochMs(n.todo_due, await userTz(n.user_id));
    const timing =
      dueMs !== null && dueMs <= nowMs
        ? "已到期"
        : /^\d{4}-\d{2}-\d{2}$/.test(n.todo_due ?? "")
          ? "今天到期"
          : "30 分钟后到期";
    const payload: PushPayload = {
      title: "⏰ 待办提醒",
      body: `${timing}：${label}`,
      url: "/#/todos",
      tag: `todo-${n.id}`,
    };
    for (const s of subs) {
      const r = await sendPush(env, s, payload);
      if (r === "ok") {
        okCount++;
        stats.delivered++;
      } else if (r === "gone") {
        goneCount++;
      }
    }
    // 补投（R142 D-2）：全部投递失败时释放标记，让下一轮 cron 在 24h 回看窗口内
    // 重试；只要有一条成功就保持已提醒（至多一次）。全部订阅已失效（gone，行已
    // 删除）则回到"无渠道"语义：重新订阅后仍能收到这条提醒。站内兜底为待办页的
    // 已过期/今天分组（Web/Android 均有），不依赖推送渠道。
    if (okCount === 0) {
      await env.DB.prepare("UPDATE notes SET todo_reminded_at = NULL WHERE id = ?")
        .bind(n.id)
        .run()
        .catch(() => undefined);
      stats.reminded--;
      if (goneCount === subs.length) {
        subCache.set(n.user_id, []);
        stats.skipped_no_sub++;
      }
    }
  }
  await writeCronHeartbeat(env, "todo_reminder:cron", "cron", stats);
  return stats;
}

/** YYYY-MM-DD and hour-of-day in an IANA timezone (falls back to Asia/Shanghai). */
export function localDateHour(tz: string | null, now: Date): { date: string; hour: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) % 24 };
  } catch {
    return { date: shanghaiDate(now), hour: (now.getUTCHours() + 8) % 24 };
  }
}

/** Local hour (inclusive) from which the daily review push may fire. */
export const DAILY_PUSH_HOUR = 8;

export interface DailyPushStats {
  users: number;
  pushed: number;
  delivered: number;
  empty: number;
  not_time: number;
  already: number;
}

/**
 * Cron sweep: once per user per local day, from 08:00 local time in the
 * user's preference timezone (same source as review generation, so the push
 * "today" and the review "today" can never disagree), push one daily-review
 * summary. Respects the daily_review_push preference; logs even empty days so
 * the 10-minute cron doesn't regenerate reviews all day.
 */
export async function sweepDailyReviewPush(env: Env, now: Date = new Date()): Promise<DailyPushStats> {
  const stats: DailyPushStats = { users: 0, pushed: 0, delivered: 0, empty: 0, not_time: 0, already: 0 };
  if (!pushConfigured(env)) return stats;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.user_id FROM push_subscriptions s
       LEFT JOIN user_preferences p ON p.user_id = s.user_id
      WHERE COALESCE(p.daily_review_push, 1) = 1`
  ).all<{ user_id: string }>();
  const users = (results ?? []).map((r) => r.user_id);
  stats.users = users.length;

  for (const userId of users) {
    try {
      const subs = await userSubscriptions(env, userId);
      if (subs.length === 0) continue;
      const { date, hour } = localDateHour(await loadUserTz(env, userId), now);
      if (hour < DAILY_PUSH_HOUR) {
        stats.not_time++;
        continue;
      }
      const logged = await env.DB.prepare("SELECT 1 AS x FROM push_daily_log WHERE user_id = ? AND review_date = ?")
        .bind(userId, date)
        .first<{ x: number }>();
      if (logged) {
        stats.already++;
        continue;
      }
      // claim the slot first: at most one push per user per local day
      await env.DB.prepare("INSERT OR IGNORE INTO push_daily_log (user_id, review_date) VALUES (?, ?)").bind(userId, date).run();
      const review = await getTodayReview(env, userId, now);
      if (review.items.length === 0) {
        stats.empty++;
        continue;
      }
      const first = review.items[0];
      // same masking as todo reminders: sensitive rows never leak into a push
      const snippet = first.note.is_sensitive ? "一条记录" : (first.note.title || first.note.content || "").slice(0, 60);
      const payload: PushPayload = {
        title: "☀️ 今日回顾",
        body: `${first.kind_label}：${snippet}`,
        url: "/#/",
        tag: `daily-review-${date}`,
      };
      stats.pushed++;
      for (const s of subs) {
        if ((await sendPush(env, s, payload)) === "ok") stats.delivered++;
      }
    } catch (e) {
      console.error(`daily review push failed for user=${userId}`, e);
    }
  }
  await writeCronHeartbeat(env, "daily_review_push:cron", "cron", stats);
  return stats;
}
