import type { Env } from "./types";

/**
 * Every table holding rows keyed by a `user_id` foreign key to users(id).
 * The account-deletion cascade iterates this list, so adding a migration with
 * a new `REFERENCES users(id)` table only requires one entry here — the
 * account-cascade test scans migrations/ and fails if this list drifts.
 */
export const USER_ID_TABLES = [
  // daily_reviews.note_id references notes(id): it must be cleared before notes
  "daily_reviews",
  "notes",
  "threads",
  "weekly_reports",
  "entities",
  "edges",
  "user_preferences",
  "push_subscriptions",
  "push_daily_log",
  "thread_jobs",
  "thread_backfill",
  "wechat_mp_bindings",
  "wechat_mp_bind_codes",
  "wecom_kf_bindings",
] as const;

/** Tables keyed by a note_id foreign key; cleared before their parent notes. */
export const NOTE_ID_TABLES = ["attachments", "note_embeddings"] as const;

/**
 * Delete every D1 row belonging to a user, children first, then the user row
 * itself. External stores (R2 media, Vectorize) are handled by the caller.
 */
export async function deleteUserData(env: Env, userId: string): Promise<void> {
  // auth_rate_limits 无 user_id 列，key 形如 "<action>:<userId>" 或
  // "<action>:acct:<name>"：注销时一并清掉可归属到该账号的行（纯 IP 维度的
  // 行无法归属，留给 24h 保留期 sweep）。userId/name 里的 _ 是 LIKE 通配符，
  // 必须转义，否则 u_boss 的模式会误删 uXboss 的行。
  const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const user = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>();
  // single atomic batch: one D1 round trip, all-or-nothing — a mid-cascade
  // failure can't leave the account half-deleted while the UI reports success
  await env.DB.batch([
    ...NOTE_ID_TABLES.map((t) =>
      env.DB.prepare(`DELETE FROM ${t} WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?)`).bind(userId)
    ),
    ...USER_ID_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId)),
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE key LIKE '%:' || ? ESCAPE '\\'").bind(likeEscape(userId)),
    ...(user?.name
      ? [env.DB.prepare("DELETE FROM auth_rate_limits WHERE key LIKE '%:acct:' || ? ESCAPE '\\'").bind(likeEscape(user.name))]
      : []),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
