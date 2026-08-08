import type { Env } from "./types";

/**
 * Every table holding rows keyed by a `user_id` foreign key to users(id).
 * The account-deletion cascade iterates this list, so adding a migration with
 * a new `REFERENCES users(id)` table only requires one entry here — the
 * account-cascade test scans migrations/ and fails if this list drifts.
 */
export const USER_ID_TABLES = [
  "notes",
  "threads",
  "weekly_reports",
  "entities",
  "edges",
  "daily_reviews",
  "user_preferences",
] as const;

/** Tables keyed by a note_id foreign key; cleared before their parent notes. */
export const NOTE_ID_TABLES = ["attachments", "note_embeddings"] as const;

/**
 * Delete every D1 row belonging to a user, children first, then the user row
 * itself. External stores (R2 media, Vectorize) are handled by the caller.
 */
export async function deleteUserData(env: Env, userId: string): Promise<void> {
  for (const t of NOTE_ID_TABLES) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?)`)
      .bind(userId)
      .run();
  }
  for (const t of USER_ID_TABLES) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
}
