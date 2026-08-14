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

/**
 * Per-user per-minute cap on single-note ingestion (速记/微信/媒体，MCP/扩展/
 * Android 都经 /api/notes)：bounds AI-quota abuse from a leaked token. R122 P1-5：
 * 同一限额覆盖所有触发 AI 入库管线的单笔入口，不再只限 POST /api/notes。
 */
export const NOTE_WRITE_RATE_LIMIT_MAX = 60;

/**
 * Per-user per-minute cap on bulk ingestion operations (导入/备份恢复)。按次而
 * 非按笔限：单次合法导入可含数千笔（后台 cron 分批消化 AI 管线），按笔计费会
 * 误伤正常迁移；按次限频已能封住泄露 token 的批量灌库滥用。
 */
export const BULK_INGEST_RATE_LIMIT_MAX = 3;

/** Retention window (最近删除) before a soft-deleted note is hard-deleted by the cron sweep. */
export const SOFT_DELETE_RETENTION_DAYS = 30;

/** Wall-clock budget for the cron retriage sweep; must stay under the 10-min cron interval. */
export const RETRIAGE_TIME_BUDGET_MS = 8 * 60_000;

/**
 * How long a note may stay unsorted before the sweep gives it the fallback
 * category (+ needs_retriage marker) instead of leaving an endless spinner.
 */
export const TRIAGE_DEGRADE_AFTER_MS = 60 * 60_000;
