export type NoteSource = "wechat" | "android" | "web" | "api"
export type NoteRawType = "text" | "link" | "image" | "voice" | "file"
export type NoteCategory = "idea" | "todo" | "collect" | "data"

export interface Note {
  id: string
  user_id: string
  source: NoteSource
  raw_type: NoteRawType
  content: string
  url: string | null
  url_title: string | null
  url_summary: string | null
  url_titles?: { url: string; title: string | null }[] | null
  title?: string | null
  category: NoteCategory | null
  tags: string[]
  thread_id: string | null
  is_sensitive: number
  todo_due: string | null
  todo_done: number | null
  created_at: string
  updated_at: string
}

export interface NotesResponse {
  notes: Note[]
  cursor: string | null
}

export interface CreateNotePayload {
  source: NoteSource
  raw_type: NoteRawType
  content: string
  url?: string
}

export interface AskReference {
  index: number
  note_id: string
}

export interface AskHistoryMessage {
  role: "user" | "assistant"
  content: string
}

export interface AskResponse {
  answer: string
  references?: AskReference[]
  notes: Note[]
}

export interface NotesQuery {
  category?: string
  tag?: string
  q?: string
  cursor?: string
  limit?: number
}

export interface Thread {
  id: string
  user_id: string
  title: string
  summary: string | null
  note_count: number
  updated_at: string
}

export interface ThreadDetail extends Thread {
  notes: Note[]
}

export interface ThreadsResponse {
  threads: Thread[]
}

export interface WeeklyReport {
  id: string
  user_id: string
  week_start: string
  content_md?: string
  created_at: string
}

export interface ReportsResponse {
  reports: WeeklyReport[]
}
