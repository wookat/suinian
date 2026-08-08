export type NoteSource = "wechat" | "android" | "web" | "api" | "extension" | "from-ask"
export type NoteRawType = "text" | "link" | "image" | "voice" | "file"
export type NoteCategory = "idea" | "todo" | "collect" | "data" | "expense" | "income"

export interface NoteMeta {
  raw_transcript?: string
  image_description?: string
  link_site?: string
  link_excerpt?: string
  link_status?: "ok" | "no_content" | "fetch_failed"
  link_fetched_at?: string
  file_name?: string
  file_mime?: string
  file_size?: number
  file_kind?: string
  file_excerpt?: string
  file_status?: "ok" | "extract_failed"
  finance_merchant?: string
  manual_override?: { category?: boolean; tags?: boolean }
  /** 问答写回：由「存为笔记」保存的问答结论 */
  from_ask?: boolean
}

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
  done_at?: string | null
  amount?: number | null
  currency?: string | null
  meta?: NoteMeta | null
  /** Search recall type when returned from a text search (semantic = no keyword hit). */
  match?: "keyword" | "semantic" | "both"
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
  /** 手动打标（# 内联指令）：入库即带标签且不被 AI 改写 */
  tags?: string[]
  /** 原样保存（! 内联指令）：跳过 AI 分拣，存为「想法」 */
  skip_triage?: boolean
  meta?: NoteMeta | null
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

export interface NotePatch {
  content?: string
  title?: string
  category?: NoteCategory
  tags?: string[]
  todo_due?: string | null
  todo_done?: number
  is_sensitive?: number
}

export interface TagCount {
  tag: string
  count: number
}

export type BatchAction = "delete" | "add_tags" | "remove_tags" | "set_category"

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
  /** 最新一条碎片的创建时间（列表接口返回） */
  last_note_at?: string | null
}

export interface ThreadGraphEntity {
  id: string
  name: string
  type: string
  note_count: number
}

export interface ThreadGraphRelation {
  src: string
  src_id: string
  relation: string
  relation_label: string
  dst: string
  dst_id: string
  confidence: number
  note_id: string | null
}

export interface ThreadGraphMention {
  entity_id: string
  note_id: string
}

export interface ThreadGraph {
  entities: ThreadGraphEntity[]
  relations: ThreadGraphRelation[]
  mentions?: ThreadGraphMention[]
}

export interface ThreadDetail extends Thread {
  notes: Note[]
  graph?: ThreadGraph | null
}

export interface ThreadsResponse {
  threads: Thread[]
}

export type ReportPeriod = "week" | "month"

export interface WeeklyReport {
  id: string
  user_id: string
  week_start: string
  period?: ReportPeriod
  content_md?: string
  created_at: string
}

export interface ReportsResponse {
  reports: WeeklyReport[]
}

export type ReviewKind = "year_ago" | "month_ago" | "revisit"

export interface DailyReviewItem {
  id: string
  kind: ReviewKind
  kind_label: string
  comment: string | null
  note: Note
}

export interface TodayReviewResponse {
  date: string
  items: DailyReviewItem[]
}
