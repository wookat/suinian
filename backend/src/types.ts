export type Env = {
  DB: D1Database;
  AI?: Ai;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
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

export interface NoteRow {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  url_title: string | null;
  url_summary: string | null;
  category: Category | null;
  tags: string;
  title: string | null;
  thread_id: string | null;
  is_sensitive: number;
  todo_due: string | null;
  todo_done: number;
  created_at: string;
  updated_at: string;
}
