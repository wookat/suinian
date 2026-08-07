export type Env = {
  DB: D1Database;
  AI?: Ai;
  MEDIA?: R2Bucket;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  SUINIAN_ENC_KEY?: string;
  /** "false"/"0"/"off" disables /api/auth/register (default: enabled). */
  REGISTRATION_ENABLED?: string;
};

export interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  note_count: number;
  updated_at: string;
}

export interface WeeklyReportRow {
  id: string;
  user_id: string;
  week_start: string;
  content_md: string;
  created_at: string;
}

export type Category = "idea" | "todo" | "collect" | "data";

export interface TriageResult {
  category: Category;
  tags: string[];
  title: string;
  is_sensitive: boolean;
  todo_due?: string | null;
}

/** Optional per-note metadata stored as JSON in notes.meta. */
export interface NoteMeta {
  /** Original Whisper transcript before LLM correction (audio notes). */
  raw_transcript?: string;
  /** Full vision-model description (image notes). */
  image_description?: string;
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
  meta: string | null;
  created_at: string;
  updated_at: string;
}
