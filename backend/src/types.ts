export type Env = {
  DB: D1Database;
  AI?: Ai;
  /** Optional Vectorize index; when absent semantic recall falls back to D1-stored vectors. */
  VECTORIZE?: VectorizeIndex;
  MEDIA?: R2Bucket;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  SUINIAN_ENC_KEY?: string;
  /** "false"/"0"/"off" disables /api/auth/register (default: enabled). */
  REGISTRATION_ENABLED?: string;
  /** Secret token guarding /api/admin/* maintenance endpoints; unset = endpoints disabled. */
  ADMIN_TOKEN?: string;
};

export interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  note_count: number;
  updated_at: string;
}

export type ReportPeriod = "week" | "month";

export interface WeeklyReportRow {
  id: string;
  user_id: string;
  week_start: string;
  period: ReportPeriod;
  content_md: string;
  created_at: string;
}

export type Category = "idea" | "todo" | "collect" | "data" | "expense" | "income";

export interface TriageResult {
  category: Category;
  tags: string[];
  title: string;
  is_sensitive: boolean;
  todo_due?: string | null;
  /** Amount for expense/income notes; null when the amount is uncertain. */
  amount?: number | null;
  /** ISO 4217 currency code (e.g. CNY, USD) for expense/income notes. */
  currency?: string | null;
  /** Optional merchant / purpose for expense/income notes. */
  merchant?: string | null;
}

/** Optional per-note metadata stored as JSON in notes.meta. */
export interface NoteMeta {
  /** Original Whisper transcript before LLM correction (audio notes). */
  raw_transcript?: string;
  /** Full vision-model description (image notes). */
  image_description?: string;
  /** Site name of the linked page (link notes). */
  link_site?: string;
  /** Extracted article text, first ~2k chars (link notes). */
  link_excerpt?: string;
  /** Result of the last article-extraction attempt (link notes). */
  link_status?: "ok" | "no_content" | "fetch_failed";
  /** ISO timestamp of the last article-extraction attempt (link notes). */
  link_fetched_at?: string;
  /** Original file name (file notes). */
  file_name?: string;
  /** Original file MIME type (file notes). */
  file_mime?: string;
  /** Original file size in bytes (file notes). */
  file_size?: number;
  /** Detected file kind: pdf / txt / md / docx (file notes). */
  file_kind?: string;
  /** Extracted full-text excerpt, first ~6k chars (long file notes). */
  file_excerpt?: string;
  /** Result of the text extraction attempt (file notes). */
  file_status?: "ok" | "extract_failed";
  /** Export source this note was imported from (imported notes). */
  import_source?: string;
  /** Original tags from the export file, merged back after AI triage (imported notes). */
  import_tags?: string[];
  /** Merchant / purpose of an expense/income note. */
  finance_merchant?: string;
  /** Fields the user set by hand; AI triage / cron sweeps must not overwrite them. */
  manual_override?: { category?: boolean; tags?: boolean };
}

export interface NoteRow {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  url_title: string | null;
  url_summary: string | null;
  url_titles: string | null;
  category: Category | null;
  tags: string;
  title: string | null;
  thread_id: string | null;
  is_sensitive: number;
  content_enc: string | null;
  todo_due: string | null;
  todo_done: number;
  done_at: string | null;
  amount: number | null;
  currency: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
}
