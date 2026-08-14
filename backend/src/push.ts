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

/**
 * Due-time of a todo in epoch ms. `todo_due` is either a bare date
 * (YYYY-MM-DD, treated as 09:00 Asia/Shanghai), a datetime with a UTC offset,
 * or a legacy offset-less datetime (Asia/Shanghai local).
 */
export function todoDueEpochMs(due: string | null): number | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return Date.parse(`${due}T09:00:00+08:00`);
  const m = due.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/);
  const t = m ? Date.parse(`${m[1]}T${m[2]}:00+08:00`) : Date.parse(due);
  return Number.isNaN(t) ? null : t;
}

const REMINDER_LOOKBACK_MS = 24 * 3600 * 1000;

/** Lead time before a timed due at which the reminder fires. */
export const REMINDER_LEAD_MS = 30 * 60_000;

/**
 * When to remind for a todo: 30 minutes before a timed due, or 08:00
 * Asia/Shanghai on the due day for bare dates (before the day's implicit
 * 09:00 due). Reminders are useful before the deadline, not after it.
 */
export function todoReminderEpochMs(due: string | null): number | null {
  if (!due) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return Date.parse(`${due}T08:00:00+08:00`);
  const t = todoDueEpochMs(due);
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
 * which are unfinished and not yet reminded. Each todo is marked reminded
 * exactly once, before delivery is attempted, so a flaky push service can
 * never cause duplicate reminders.
 */
export async function sweepTodoReminders(env: Env, now: Date = new Date()): Promise<TodoReminderStats> {
  const stats: TodoReminderStats = { candidates: 0, reminded: 0, delivered: 0, skipped_pref: 0, skipped_no_sub: 0 };
  if (!pushConfigured(env)) return stats;
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes
      WHERE deleted_at IS NULL AND category = 'todo'
        AND (todo_done IS NULL OR todo_done = 0)
        AND todo_reminded_at IS NULL AND todo_due IS NOT NULL
      LIMIT 200`
  ).all<NoteRow>();
  const nowMs = now.getTime();
  const dueRows = (results ?? []).filter((n) => {
    const t = todoReminderEpochMs(n.todo_due);
    return t !== null && t <= nowMs && t >= nowMs - REMINDER_LOOKBACK_MS;
  });
  stats.candidates = dueRows.length;

  const subCache = new Map<string, PushSubRow[]>();
  const prefCache = new Map<string, boolean>();
  for (const n of dueRows) {
    // mark first: at-most-once even if delivery below fails midway
    await env.DB.prepare("UPDATE notes SET todo_reminded_at = datetime('now') WHERE id = ?").bind(n.id).run();
    stats.reminded++;
    if (!prefCache.has(n.user_id)) {
      const p = await env.DB.prepare("SELECT todo_reminder_push FROM user_preferences WHERE user_id = ?")
        .bind(n.user_id)
        .first<{ todo_reminder_push: number }>();
      prefCache.set(n.user_id, p ? p.todo_reminder_push === 1 : true);
    }
    if (!prefCache.get(n.user_id)) {
      stats.skipped_pref++;
      continue;
    }
    if (!subCache.has(n.user_id)) subCache.set(n.user_id, await userSubscriptions(env, n.user_id));
    const subs = subCache.get(n.user_id)!;
    if (subs.length === 0) {
      stats.skipped_no_sub++;
      continue;
    }
    const label = n.is_sensitive ? "一条待办" : (n.title || n.content || "待办").slice(0, 60);
    const dueMs = todoDueEpochMs(n.todo_due);
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
      if ((await sendPush(env, s, payload)) === "ok") stats.delivered++;
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
 * Cron sweep: once per user per local day, from 08:00 local time (timezone of
 * the user's most recent subscription), push one daily-review summary.
 * Respects the daily_review_push preference; logs even empty days so the
 * 10-minute cron doesn't regenerate reviews all day.
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
      const { date, hour } = localDateHour(subs[0].tz, now);
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
      const snippet = (first.note.title || first.note.content || "").slice(0, 60);
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
