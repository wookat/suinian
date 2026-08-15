import type { Env, NoteRow } from "./types";
import { clusterNote, newRebuildState, rebuildStep, summarizeThread, THREAD_CATEGORIES, type RebuildState } from "./threads";

/** Wall-clock budget for the slice run inside the rebuild request's waitUntil. */
export const REBUILD_SLICE_BUDGET_MS = 4 * 60_000;
/** Wall-clock budget for the cron slice that resumes queued/stale jobs. */
export const REBUILD_CRON_BUDGET_MS = 3 * 60_000;
/** Wall-clock budget for the cron full-history clustering backfill. */
export const CLUSTER_BACKFILL_BUDGET_MS = 2 * 60_000;
/** A running job whose heartbeat is older than this is considered stale (its slice died). */
const JOB_STALE_MINUTES = 3;
/**
 * Hard lifetime cap: a job still not done this long after creation is marked
 * error instead of being resumed again. A healthy thousand-note rebuild
 * finishes well within this; anything older means the state machine is
 * looping without progress, and 'error' is the only way the user (and the
 * next audit) can see that instead of an eternal 'running'.
 */
export const JOB_MAX_AGE_MINUTES = 60;

export interface ThreadJobRow {
  id: string;
  user_id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  phase: string;
  total: number;
  processed: number;
  threads: number | null;
  state: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function getThreadJob(env: Env, userId: string, jobId: string): Promise<ThreadJobRow | null> {
  return env.DB.prepare("SELECT * FROM thread_jobs WHERE id = ? AND user_id = ?")
    .bind(jobId, userId)
    .first<ThreadJobRow>();
}

/** The user's queued/running rebuild job, if any (one active job per user). */
export async function getActiveThreadJob(env: Env, userId: string): Promise<ThreadJobRow | null> {
  return env.DB.prepare(
    "SELECT * FROM thread_jobs WHERE user_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userId)
    .first<ThreadJobRow>();
}

export async function createRebuildJob(env: Env, userId: string, opts?: { useGraph?: boolean }): Promise<ThreadJobRow> {
  const id = crypto.randomUUID();
  const state = newRebuildState(opts);
  await env.DB.prepare(
    "INSERT INTO thread_jobs (id, user_id, kind, status, phase, state) VALUES (?, ?, 'rebuild', 'queued', ?, ?)"
  )
    .bind(id, userId, state.phase, JSON.stringify(state))
    .run();
  return (await getThreadJob(env, userId, id))!;
}

async function saveJobProgress(env: Env, jobId: string, state: RebuildState, status: string, error?: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE thread_jobs SET status = ?, phase = ?, total = ?, processed = ?, threads = ?, state = ?, error = ?,
       updated_at = datetime('now') WHERE id = ?`
  )
    .bind(
      status,
      state.phase,
      state.total,
      state.processed,
      state.phase === "done" ? state.threads : null,
      JSON.stringify(state),
      error ?? null,
      jobId
    )
    .run();
}

/**
 * Drive a rebuild job forward until it finishes or the time budget is spent.
 * Progress (state + counters) is persisted after every step so another slice
 * (the 10-minute cron) can resume where this one stopped. Never throws.
 */
export async function runRebuildJobSlice(env: Env, jobId: string, timeBudgetMs: number): Promise<void> {
  const deadline = Date.now() + timeBudgetMs;
  try {
    const job = await env.DB.prepare("SELECT * FROM thread_jobs WHERE id = ?").bind(jobId).first<ThreadJobRow>();
    if (!job || job.status === "done" || job.status === "error") return;
    const expired = await env.DB.prepare(
      `SELECT 1 AS x FROM thread_jobs WHERE id = ? AND created_at < datetime('now', '-${JOB_MAX_AGE_MINUTES} minutes')`
    )
      .bind(jobId)
      .first<{ x: number }>();
    if (expired) {
      await env.DB.prepare(
        "UPDATE thread_jobs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(`重建超过 ${JOB_MAX_AGE_MINUTES} 分钟未完成，已终止（可重新发起）`, jobId)
        .run();
      return;
    }
    let state: RebuildState;
    try {
      state = job.state ? (JSON.parse(job.state) as RebuildState) : newRebuildState();
    } catch {
      state = newRebuildState();
    }
    await saveJobProgress(env, jobId, state, "running");
    while (state.phase !== "done" && Date.now() < deadline) {
      // each step is bounded internally; checkpoint after every step so a
      // dead slice loses at most one batch of work
      state = await rebuildStep(env, job.user_id, state, Math.min(deadline, Date.now() + 30_000));
      await saveJobProgress(env, jobId, state, state.phase === "done" ? "done" : "running");
    }
    if (state.phase === "done") {
      // the rebuild consumed the full history: fast-forward the backfill cursor
      await markBackfillDone(env, job.user_id).catch(() => {});
    }
  } catch (err) {
    console.error(`threads: rebuild job ${jobId} slice failed`, err);
    await env.DB.prepare(
      "UPDATE thread_jobs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ? AND status != 'done'"
    )
      .bind(String(err).slice(0, 500), jobId)
      .run()
      .catch(() => {});
  }
}

/** Cron sweep: resume queued jobs and running jobs whose slice died (stale heartbeat). */
export async function resumeThreadJobs(env: Env, timeBudgetMs = REBUILD_CRON_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + timeBudgetMs;
  const { results } = await env.DB.prepare(
    `SELECT id FROM thread_jobs
      WHERE status = 'queued' OR (status = 'running' AND updated_at < datetime('now', '-${JOB_STALE_MINUTES} minutes'))
      ORDER BY created_at ASC LIMIT 10`
  ).all<{ id: string }>();
  for (const j of results ?? []) {
    const remaining = deadline - Date.now();
    if (remaining <= 5_000) break;
    await runRebuildJobSlice(env, j.id, remaining);
  }
}

// ---------------------------------------------------------------------------
// Full-history clustering backfill (cron): consume every idea note ever saved,
// oldest first, recording a per-user (created_at, id) cursor so large imported
// histories get clustered within days without any user action.
// ---------------------------------------------------------------------------

const BACKFILL_BATCH = 10;

interface BackfillRow {
  user_id: string;
  cursor_created_at: string;
  cursor_id: string;
  done: number;
  processed: number;
}

async function markBackfillDone(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO thread_backfill (user_id, cursor_created_at, cursor_id, done, updated_at)
     VALUES (?, '9999-12-31 23:59:59', '', 1, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET cursor_created_at = '9999-12-31 23:59:59', cursor_id = '', done = 1, updated_at = datetime('now')`
  )
    .bind(userId)
    .run();
}

/** Rewind a user's clustering cursor (called after imports add old-dated notes). */
export async function resetThreadBackfill(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO thread_backfill (user_id, cursor_created_at, cursor_id, done, updated_at)
     VALUES (?, '', '', 0, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET cursor_created_at = '', cursor_id = '', done = 0, updated_at = datetime('now')`
  )
    .bind(userId)
    .run();
}

async function saveBackfillCursor(env: Env, userId: string, createdAt: string, id: string, processedDelta: number, done: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO thread_backfill (user_id, cursor_created_at, cursor_id, done, processed, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET cursor_created_at = ?2, cursor_id = ?3, done = ?4,
       processed = processed + ?5, updated_at = datetime('now')`
  )
    .bind(userId, createdAt, id, done ? 1 : 0, processedDelta)
    .run();
}

/**
 * Cron worker: advance every user's clustering cursor over their full idea
 * history (oldest first), clustering still-unthreaded notes with the frugal
 * path (embedding prescreen + at most one LLM confirm per note). Threads
 * touched in a run are summarized once at the end. Never throws.
 */
export async function backfillThreadClusters(env: Env, timeBudgetMs = CLUSTER_BACKFILL_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + timeBudgetMs;
  try {
    // users with unthreaded ideas whose cursor hasn't consumed everything yet;
    // users with an active rebuild job are skipped (the job owns their threads)
    const { results: users } = await env.DB.prepare(
      `SELECT DISTINCT n.user_id FROM notes n
        LEFT JOIN thread_backfill b ON b.user_id = n.user_id
        WHERE n.category IN ${THREAD_CATEGORIES} AND n.deleted_at IS NULL AND n.thread_id IS NULL
          AND (b.user_id IS NULL OR b.done = 0)
          AND n.user_id NOT IN (SELECT user_id FROM thread_jobs WHERE status IN ('queued','running'))
        LIMIT 20`
    ).all<{ user_id: string }>();
    for (const u of users ?? []) {
      if (Date.now() >= deadline) return;
      await backfillUser(env, u.user_id, deadline);
    }
  } catch (err) {
    console.error("threads: cluster backfill failed", err);
  }
}

async function backfillUser(env: Env, userId: string, deadline: number): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM thread_backfill WHERE user_id = ?")
    .bind(userId)
    .first<BackfillRow>();
  let cursorCreatedAt = row?.cursor_created_at ?? "";
  let cursorId = row?.cursor_id ?? "";
  const touched = new Set<string>();
  let processed = 0;
  while (Date.now() < deadline) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM notes WHERE user_id = ?1 AND category IN ${THREAD_CATEGORIES} AND deleted_at IS NULL
         AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
       ORDER BY created_at ASC, id ASC LIMIT ${BACKFILL_BATCH}`
    )
      .bind(userId, cursorCreatedAt, cursorId)
      .all<NoteRow>();
    const rows = results ?? [];
    if (rows.length === 0) {
      await saveBackfillCursor(env, userId, cursorCreatedAt, cursorId, processed, true);
      processed = 0;
      break;
    }
    for (const n of rows) {
      if (n.thread_id === null) {
        const tid = await clusterNote(env, n, { frugal: true, deferSummaries: true });
        if (tid) touched.add(tid);
        processed++;
      }
      cursorCreatedAt = n.created_at;
      cursorId = n.id;
      if (Date.now() >= deadline) break;
    }
    await saveBackfillCursor(env, userId, cursorCreatedAt, cursorId, processed, false);
    processed = 0;
  }
  if (processed > 0) await saveBackfillCursor(env, userId, cursorCreatedAt, cursorId, processed, false);
  for (const tid of touched) {
    await summarizeThread(env, tid);
    if (Date.now() >= deadline + 30_000) break; // small grace period for summaries
  }
  if (touched.size > 0) console.log(`threads: backfill user=${userId} touched=${touched.size} threads`);
}
