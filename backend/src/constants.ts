/**
 * Non-function constants live here rather than in index.ts: workerd rejects
 * entry-module exports that are not functions or ExportedHandler objects, so
 * exporting plain values from index.ts breaks `wrangler dev`.
 */

/**
 * Upper bound for a note's background pipeline (triage + graph + cluster +
 * embedding + link enrichment). Every network call inside already has its own
 * 8-40s timeout; this cap is a second line of defense so a waitUntil task can
 * never run unbounded (anything unfinished is picked up by the cron sweep).
 */
export const PIPELINE_TIMEOUT_MS = 60_000;

export const SENSITIVE_EXPORT_PLACEHOLDER = "[已加密内容]";

/** Retention window (最近删除) before a soft-deleted note is hard-deleted by the cron sweep. */
export const SOFT_DELETE_RETENTION_DAYS = 30;

/** Wall-clock budget for the cron retriage sweep; must stay under the 10-min cron interval. */
export const RETRIAGE_TIME_BUDGET_MS = 8 * 60_000;
