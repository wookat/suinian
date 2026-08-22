-- R246 F-7 (audit-r245): persist SW registration-failure beacons to D1 so the
-- last 7 days can be aggregated programmatically (Workers Logs history isn't
-- queryable via API token). Same sanitized fields as the structured log —
-- no user content, credentials or IP.
CREATE TABLE IF NOT EXISTS sw_error_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  retry INTEGER,
  ua TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sw_error_reports_reported_at ON sw_error_reports(reported_at);
