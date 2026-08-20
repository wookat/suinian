export type NoteSource = "wechat" | "android" | "web" | "api" | "extension" | "from-ask" | "import" | "mcp"
export type NoteRawType = "text" | "link" | "image" | "voice" | "file"
export type NoteCategory = "idea" | "todo" | "collect" | "data" | "expense" | "income" | "transfer"

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
  media_status?: "ok" | "extract_failed"
  /** 语音转写低置信（R212 P2-1）：卡片提示核对并给纠错入口，编辑正文后清除 */
  transcript_suspect?: boolean
  /** 图片文字识别存疑（R212 P3-3）：卡片提示核对原图，编辑正文后清除 */
  ocr_suspect?: boolean
  finance_merchant?: string
  manual_override?: { category?: boolean; tags?: boolean; todo_due?: boolean; title?: boolean }
  /** 问答写回：由「存为笔记」保存的问答结论 */
  from_ask?: boolean
  import_source?: string
  /** 批量导入的入库时间（区别于保留的原 created_at），用于分拣延迟判断 */
  imported_at?: string
  /** 分拣重试达上限的终态失败：已按兜底分类保存，手动改分类即清除 */
  triage_failed?: boolean
  /** 分拣失败归因（R214 P1-1）：模型有响应但输出解析不出合法 JSON */
  triage_parse_failed?: boolean
  /** whisper 平均 logprob（R214 P1-2）：低置信阈值的观测依据 */
  transcript_logprob?: number
  /** 分拣判定内容像在提问（无问号疑问句）：卡片渲染「去问 AI」轻量入口 */
  is_question?: boolean
}

/** 附件元数据（R144 P1-1）：仅元信息，取件走鉴权 API，不含任何直链 */
export interface NoteAttachment {
  id: string
  name: string
  mime: string | null
  size: number | null
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
  attachments?: NoteAttachment[] | null
  /** Search recall type when returned from a text search (semantic = no keyword hit). */
  match?: "keyword" | "semantic" | "both"
  created_at: string
  updated_at: string
}

/** 最近删除（回收站）里的笔记：附软删时间与预计彻底清理时间 */
export interface TrashNote extends Note {
  deleted_at: string | null
  purge_at: string | null
}

export interface TrashResponse {
  notes: TrashNote[]
  retention_days: number
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

export type BatchAction = "delete" | "add_tags" | "remove_tags" | "set_category" | "restore_categories"

/** 批量改分类撤销（R172 D-1）：服务端回传的每条原分类快照，供逆向恢复 */
export interface PrevCategory {
  id: string
  category: string | null
  manual: boolean
}

export interface NotesQuery {
  category?: string
  tag?: string
  q?: string
  /** 来源过滤（wechat / web / import / …） */
  source?: string
  /** 创建时间范围（UTC "YYYY-MM-DD HH:MM:SS"） */
  from?: string
  to?: string
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
  /** 最早一条碎片的创建时间（列表接口返回） */
  first_note_at?: string | null
  /** 近 7 天新增碎片数（列表接口返回） */
  week_new_count?: number
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

export interface StatsDaily {
  date: string
  count: number
}

export interface StatsResponse {
  total_notes: number
  thread_count: number
  /** 全历史按本地时区去重的记录天数 */
  active_days: number
  daily: StatsDaily[]
  streak: { current: number; longest: number }
  categories: { category: string; count: number }[]
  sources: { source: string; count: number }[]
  top_tags: { tag: string; count: number }[]
}

export interface ThreadJob {
  job_id: string
  status: "queued" | "running" | "done" | "error"
  phase: "reset" | "cluster" | "second_pass" | "summarize" | "done"
  total: number
  processed: number
  summarized: number
  summarize_total: number
  threads: number | null
  error: string | null
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
