import { loadSettings } from "./settings"
import {
  mockAsk,
  mockCreateNote,
  mockDeleteNote,
  mockGetNote,
  mockGetNotes,
  mockGenerateReport,
  mockGetReport,
  mockGetReports,
  mockGetTodayReview,
  mockGetThread,
  mockGetThreads,
  mockPatchNote,
  mockGetStats,
  mockGetRandomNote,
} from "./mock"
import type {
  AskHistoryMessage,
  AskResponse,
  BatchAction,
  CreateNotePayload,
  Note,
  NotePatch,
  NotesQuery,
  NotesResponse,
  TagCount,
  StatsResponse,
  ReportsResponse,
  ThreadDetail,
  ThreadsResponse,
  TodayReviewResponse,
  WeeklyReport,
} from "./types"

async function realFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...init?.headers,
      },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class NetworkError extends Error {}

// Backend returns booleans for is_sensitive/todo_done and wraps single notes in {note}
function normalizeNote(raw: Record<string, unknown>): Note {
  const n = raw as unknown as Note
  const sensitive: unknown = n.is_sensitive
  const done: unknown = n.todo_done
  return {
    ...n,
    tags: Array.isArray(n.tags) ? n.tags : [],
    url_titles: Array.isArray(n.url_titles) ? n.url_titles : null,
    is_sensitive: sensitive === true || sensitive === 1 ? 1 : 0,
    todo_done: done == null ? null : done === true || done === 1 ? 1 : 0,
  }
}

export async function getNotes(
  query: NotesQuery,
  signal?: AbortSignal,
): Promise<NotesResponse> {
  if (loadSettings().useMock) return mockGetNotes(query)
  const params = new URLSearchParams()
  if (query.category) params.set("category", query.category)
  if (query.tag) params.set("tag", query.tag)
  if (query.q) params.set("q", query.q)
  if (query.source) params.set("source", query.source)
  if (query.from) params.set("from", query.from)
  if (query.to) params.set("to", query.to)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  const res = await realFetch<{
    notes: Record<string, unknown>[]
    cursor?: string | null
    next_cursor?: string | null
  }>(`/api/notes${qs ? `?${qs}` : ""}`, { signal })
  return {
    notes: (res.notes ?? []).map(normalizeNote),
    cursor: res.next_cursor ?? res.cursor ?? null,
  }
}

export async function getNote(id: string): Promise<Note | null> {
  if (loadSettings().useMock) return mockGetNote(id)
  const res = await getNotes({ limit: 30 })
  return res.notes.find((n) => n.id === id) ?? null
}

export async function createNote(payload: CreateNotePayload): Promise<Note> {
  if (loadSettings().useMock) return mockCreateNote(payload)
  const res = await realFetch<Record<string, unknown>>("/api/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const raw = (res.note ?? res) as Record<string, unknown>
  return normalizeNote(raw)
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024

export const SUPPORTED_FILE_EXTS = ["pdf", "txt", "md", "markdown", "docx"]

/** 图片/文件上传：走 /api/ingest/media，后端提取文字/描述/摘要后入库 */
export async function ingestMedia(file: File, type: "image" | "file"): Promise<Note> {
  if (loadSettings().useMock) {
    return mockCreateNote({
      source: "web",
      raw_type: type,
      content: type === "image" ? `【图片】${file.name}（演示模式不做识别）` : `【文件】${file.name}（演示模式不做提取）`,
    })
  }
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  const form = new FormData()
  form.set("type", type)
  form.set("source", "web")
  form.set("file", file)
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/ingest/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  const data = (await res.json()) as { note: Record<string, unknown> }
  return normalizeNote(data.note)
}

/** 下载文件笔记的原件（鉴权本人，经 API 代理） */
export async function downloadNoteFile(noteId: string, fileName: string): Promise<void> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持下载，请先配置真实 API")
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/notes/${noteId}/file`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ApiError(res.status, text || res.statusText)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function dueEqual(a: string | null | undefined, b: string | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a === b) return true
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

/** 服务端返回的笔记是否已体现补丁字段（防「返回成功但未持久化」的静默失败） */
export function patchPersisted(fresh: Note, patch: NotePatch): boolean {
  if (patch.content !== undefined && fresh.content !== patch.content) return false
  if (patch.title !== undefined && (fresh.title ?? "") !== patch.title) return false
  if (patch.category !== undefined && fresh.category !== patch.category) return false
  if (patch.tags !== undefined && JSON.stringify(fresh.tags) !== JSON.stringify(patch.tags)) return false
  if (patch.todo_due !== undefined && !dueEqual(patch.todo_due, fresh.todo_due)) return false
  if (patch.todo_done !== undefined && (fresh.todo_done ?? 0) !== patch.todo_done) return false
  if (patch.is_sensitive !== undefined && fresh.is_sensitive !== patch.is_sensitive) return false
  return true
}

export async function patchNote(id: string, patch: NotePatch): Promise<Note> {
  if (loadSettings().useMock) return mockPatchNote(id, patch)
  const body: Record<string, unknown> = { ...patch }
  if (patch.todo_done != null) body.todo_done = patch.todo_done === 1
  if (patch.is_sensitive != null) body.is_sensitive = patch.is_sensitive === 1
  const res = await realFetch<Record<string, unknown>>(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
  const fresh = normalizeNote((res.note ?? res) as Record<string, unknown>)
  if (!patchPersisted(fresh, patch)) throw new Error("保存未生效，请重试")
  return fresh
}

/** 手动重试链接标题/正文抓取，返回更新后的笔记 */
export async function refetchLink(id: string): Promise<Note> {
  if (loadSettings().useMock) throw new Error("演示模式不支持重新抓取")
  const res = await realFetch<Record<string, unknown>>(`/api/notes/${id}/refetch-link`, {
    method: "POST",
  })
  return normalizeNote((res.note ?? res) as Record<string, unknown>)
}

export async function deleteNote(id: string): Promise<void> {
  if (loadSettings().useMock) return mockDeleteNote(id)
  await realFetch<{ ok: boolean }>(`/api/notes/${id}`, { method: "DELETE" })
}

/** 撤销删除：清除软删标记，恢复笔记（服务端单次上限 1000，超出自动分批） */
export async function restoreNotes(ids: string[]): Promise<number> {
  if (loadSettings().useMock) throw new Error("演示模式不支持恢复，请先配置真实 API")
  let restored = 0
  for (let i = 0; i < ids.length; i += 1000) {
    const res = await realFetch<{ ok: boolean; restored: number }>("/api/notes/restore", {
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(i, i + 1000) }),
    })
    restored += res.restored
  }
  return restored
}

/** 批量操作结果：affected=本次影响条数；remaining=筛选匹配超上限未处理条数；ids=删除时被软删的 id（供撤销） */
export interface BatchResult {
  affected: number
  remaining: number
  ids: string[]
}

/** NDJSON 批量流：{done,total} 进度行 + 最终 {ok,affected,remaining,ids?}（或 {error}） */
async function batchStream(
  body: Record<string, unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持批量操作，请先配置真实 API")
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/notes/batch?stream=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const legacy = (await res.json()) as { affected?: number; remaining?: number; ids?: string[] }
    return { affected: legacy.affected ?? 0, remaining: legacy.remaining ?? 0, ids: legacy.ids ?? [] }
  }
  const decoder = new TextDecoder()
  let buffer = ""
  let result: BatchResult | null = null
  const handleLine = (line: string) => {
    if (!line.trim()) return
    let obj: { done?: number; total?: number; ok?: boolean; affected?: number; remaining?: number; ids?: string[]; error?: string }
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    if (typeof obj.error === "string") throw new ApiError(500, obj.error)
    if (typeof obj.affected === "number")
      result = { affected: obj.affected, remaining: obj.remaining ?? 0, ids: Array.isArray(obj.ids) ? obj.ids : [] }
    else if (typeof obj.done === "number" && typeof obj.total === "number") onProgress?.(obj.done, obj.total)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) handleLine(line)
  }
  handleLine(buffer)
  if (result === null) throw new Error("批量操作未返回结果，请刷新时间流确认后重试")
  return result
}

/** 批量操作：删除 / 加标签 / 去标签 / 改分类（进度经 onProgress 回调） */
export async function batchNotes(
  action: BatchAction,
  ids: string[],
  opts?: { tags?: string[]; category?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  return (await batchStream({ action, ids, ...opts }, onProgress)).affected
}

export interface BatchFilter {
  category?: string
  tag?: string
  q?: string
  source?: string
  from?: string
  to?: string
}

/** 按筛选条件批量操作全部匹配笔记（服务端执行，不限已加载项；进度经 onProgress 回调） */
export async function batchNotesByFilter(
  action: BatchAction,
  filter: BatchFilter,
  opts?: { tags?: string[]; category?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  return batchStream({ action, filter, ...opts }, onProgress)
}

/** 全部标签 + 使用次数（按次数降序） */
export async function getStats(days = 365): Promise<StatsResponse> {
  if (loadSettings().useMock) return mockGetStats()
  const tz = -new Date().getTimezoneOffset()
  return realFetch<StatsResponse>(`/api/stats?days=${days}&tz_offset=${tz}`)
}

/** 随机漫步：抽一条历史笔记（后端已排除敏感/示例/软删）；无可抽时返回 null */
export async function getRandomNote(): Promise<Note | null> {
  if (loadSettings().useMock) return mockGetRandomNote()
  try {
    const res = await realFetch<{ note: Record<string, unknown> }>("/api/notes/random")
    return normalizeNote(res.note)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export async function getTags(): Promise<TagCount[]> {
  if (loadSettings().useMock) throw new Error("演示模式不支持标签管理，请先配置真实 API")
  const res = await realFetch<{ tags: TagCount[] }>("/api/tags")
  return res.tags
}

/** 重命名标签（全局替换；改名到已有标签即合并），返回影响的笔记数 */
export async function renameTag(from: string, to: string): Promise<number> {
  const res = await realFetch<{ ok: boolean; affected: number }>("/api/tags/rename", {
    method: "POST",
    body: JSON.stringify({ from, to }),
  })
  return res.affected
}

/** 从所有笔记移除标签，返回影响的笔记数 */
export async function deleteTag(tag: string): Promise<number> {
  const res = await realFetch<{ ok: boolean; affected: number }>("/api/tags/delete", {
    method: "POST",
    body: JSON.stringify({ tag }),
  })
  return res.affected
}

export async function ask(
  question: string,
  history: AskHistoryMessage[] = [],
): Promise<AskResponse> {
  if (loadSettings().useMock) return mockAsk(question)
  const res = await realFetch<AskResponse>("/api/ask", {
    method: "POST",
    body: JSON.stringify(history.length > 0 ? { question, history } : { question }),
  })
  return {
    ...res,
    notes: (res.notes ?? []).map((n) => normalizeNote(n as unknown as Record<string, unknown>)),
  }
}

export async function exportData(
  format: "json" | "markdown",
  includeSensitive: boolean,
): Promise<{ blob: Blob; filename: string }> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持导出，请先配置真实 API")
  const params = new URLSearchParams()
  if (format === "markdown") params.set("format", "markdown")
  if (includeSensitive) params.set("include_sensitive", "true")
  const qs = params.toString()
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/export${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ApiError(res.status, text || res.statusText)
  }
  const blob = await res.blob()
  const date = new Date().toISOString().slice(0, 10)
  return { blob, filename: `suinian-export-${date}.${format === "markdown" ? "md" : "json"}` }
}

/** 下载完整备份 zip（notes.json 全字段 + media/ 原件 + manifest） */
export async function downloadBackup(includeSensitive: boolean): Promise<{ blob: Blob; filename: string }> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持备份，请先配置真实 API")
  const qs = includeSensitive ? "?include_sensitive=true" : ""
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/backup${qs}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new ApiError(res.status, text || res.statusText)
  }
  const blob = await res.blob()
  const date = new Date().toISOString().slice(0, 10)
  return { blob, filename: `suinian-backup-${date}.zip` }
}

export interface RestoreStats {
  notes_total: number
  notes_imported: number
  notes_skipped: number
  media_imported: number
  media_skipped: number
  media_failed: number
}

export const MAX_RESTORE_BYTES = 200 * 1024 * 1024

/** 从完整备份 zip 恢复：笔记保原时间/标签/分类，媒体重新入库，重复自动跳过 */
export async function restoreBackup(file: File): Promise<RestoreStats> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持恢复，请先配置真实 API")
  if (file.size > MAX_RESTORE_BYTES) throw new Error("备份文件过大：最大支持 200MB")
  const form = new FormData()
  form.set("file", file)
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/backup/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<RestoreStats>
}

export type ImportSource = "cubox" | "flomo" | "markdown" | "text" | "notion" | "obsidian" | "apple-notes"

export interface ImportStats {
  total: number
  imported: number
  skipped: number
  failed: number
}

export interface ImportFailedItem {
  item: string
  reason: string
}

export interface ImportResult {
  stats: ImportStats
  failed_items: ImportFailedItem[]
}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/**
 * 导入导出文件（Cubox / flomo / Markdown / 纯文本 / Notion zip / Obsidian zip /
 * Apple 备忘录 zip），批量入库。服务端以 NDJSON 流返回进度，大包导入时
 * onProgress 会逐批回调；最后一行包含统计与失败条目清单。
 */
export async function importData(
  file: File,
  source: ImportSource,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持导入，请先配置真实 API")
  if (file.size > MAX_IMPORT_BYTES) throw new Error("文件过大：最大支持 20MB")
  const form = new FormData()
  form.set("source", source)
  form.set("file", file)
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/import?stream=1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  // NDJSON progress stream: {done,total} lines, then {stats,failed_items} (or {error})
  const reader = res.body?.getReader()
  if (!reader) {
    const legacy = (await res.json()) as ImportStats & { failed_items?: ImportFailedItem[] }
    return { stats: legacy, failed_items: legacy.failed_items ?? [] }
  }
  const decoder = new TextDecoder()
  let buffer = ""
  let final: ImportResult | null = null
  const handleLine = (line: string) => {
    if (!line.trim()) return
    let obj: { done?: number; total?: number; stats?: ImportStats; failed_items?: ImportFailedItem[]; error?: string }
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    if (typeof obj.error === "string") throw new ApiError(500, obj.error)
    if (obj.stats) final = { stats: obj.stats, failed_items: obj.failed_items ?? [] }
    else if (typeof obj.done === "number" && typeof obj.total === "number") onProgress?.(obj.done, obj.total)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) handleLine(line)
  }
  handleLine(buffer)
  if (!final) throw new Error("导入未返回结果，请刷新时间流确认后重试")
  return final
}

export async function getThreads(): Promise<ThreadsResponse> {
  if (loadSettings().useMock) return mockGetThreads()
  return realFetch<ThreadsResponse>("/api/threads")
}

export async function getThread(id: string): Promise<ThreadDetail> {
  if (loadSettings().useMock) return mockGetThread(id)
  const res = await realFetch<
    ThreadDetail & { thread?: ThreadDetail; notes?: Record<string, unknown>[]; graph?: ThreadDetail["graph"] }
  >(`/api/threads/${id}`)
  const detail = (res.thread ? { ...res.thread, notes: res.notes ?? [], graph: res.graph ?? null } : res) as ThreadDetail
  return {
    ...detail,
    notes: (detail.notes ?? []).map((n) => normalizeNote(n as unknown as Record<string, unknown>)),
  }
}

export async function getReports(): Promise<ReportsResponse> {
  if (loadSettings().useMock) return mockGetReports()
  return realFetch<ReportsResponse>("/api/reports")
}

/** 手动生成本周/本月报告（幂等：同期已有则重新生成覆盖） */
export async function generateReport(
  which: "this" | "last" = "this",
  period: "week" | "month" = "week",
): Promise<WeeklyReport> {
  if (loadSettings().useMock) return mockGenerateReport()
  const res = await realFetch<{ report: WeeklyReport }>("/api/reports/generate", {
    method: "POST",
    body: JSON.stringify({ week: which, which, period }),
  })
  return res.report
}

/** 今日回顾（那年今日 / 上月今日 / 久未回看） */
export async function getTodayReview(): Promise<TodayReviewResponse> {
  if (loadSettings().useMock) return mockGetTodayReview()
  const res = await realFetch<{ date: string; items: (Omit<TodayReviewResponse["items"][number], "note"> & { note: Record<string, unknown> })[] }>(
    "/api/review/today",
  )
  return {
    date: res.date,
    items: (res.items ?? []).map((it) => ({ ...it, note: normalizeNote(it.note) })),
  }
}

// The reports list omits content_md; the detail endpoint returns the full report
export async function getReport(id: string): Promise<WeeklyReport> {
  if (loadSettings().useMock) return mockGetReport(id)
  const res = await realFetch<{ report?: WeeklyReport } & WeeklyReport>(
    `/api/reports/${id}`,
  )
  return res.report ?? res
}

export interface PushPreferences {
  daily_review_push: boolean
  todo_reminder_push: boolean
}

/** 推送偏好（每日回顾 / 待办提醒开关，默认全开） */
export async function getPreferences(): Promise<PushPreferences> {
  return realFetch<PushPreferences>("/api/preferences")
}

export async function updatePreferences(patch: Partial<PushPreferences>): Promise<PushPreferences> {
  return realFetch<PushPreferences>("/api/preferences", {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export interface PushConfig {
  enabled: boolean
  vapid_public_key: string | null
  subscriptions: { endpoint: string; tz: string | null; ua: string | null; created_at: string }[]
}

/** Web Push：服务端 VAPID 公钥 + 当前账号的订阅列表 */
export async function getPushConfig(): Promise<PushConfig> {
  return realFetch<PushConfig>("/api/push/config")
}

export async function subscribePush(payload: {
  endpoint: string
  keys: { p256dh: string; auth: string }
  tz: string | null
  ua: string | null
}): Promise<void> {
  await realFetch<{ ok: boolean }>("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  await realFetch<{ ok: boolean }>("/api/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint }),
  })
}

export async function sendTestPush(): Promise<number> {
  const res = await realFetch<{ ok: boolean; delivered: number }>("/api/push/test", { method: "POST" })
  return res.delivered
}

export interface AuthResult {
  user: { id: string; name: string }
  api_token: string
}

const AUTH_TIMEOUT_MS = 30_000

async function authPost(baseUrl: string, path: string, body: unknown): Promise<AuthResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new NetworkError("请求超时，请用相同用户名密码重试一次（不会重复创建账号）")
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let message = text || res.statusText
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) message = parsed.error
    } catch {
      // not JSON, keep raw text
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<AuthResult>
}

export function register(baseUrl: string, name: string, password: string): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/register", { name, password })
}

export function login(baseUrl: string, name: string, password: string): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/login", { name, password })
}

export interface MeInfo {
  id: string
  name: string
  created_at: string
  has_password: boolean
  last_used_at: string | null
}

export async function getMe(): Promise<MeInfo> {
  const res = await realFetch<{ user: MeInfo }>("/api/auth/me")
  return res.user
}

export async function rotateToken(): Promise<string> {
  const res = await realFetch<{ api_token: string }>("/api/auth/rotate-token", { method: "POST" })
  return res.api_token
}

export async function deleteAccount(): Promise<void> {
  await realFetch<{ ok: boolean }>("/api/auth/me", { method: "DELETE" })
}

export interface TestConnectionResult {
  ok: boolean
  message: string
}

export async function testConnection(): Promise<TestConnectionResult> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock) return { ok: true, message: "当前为演示模式，无需连接" }
  if (!apiBaseUrl) return { ok: false, message: "请先填写 API Base URL" }
  if (!apiToken) return { ok: false, message: "请先填写 API Token" }
  try {
    await realFetch<NotesResponse>("/api/notes?limit=1")
    return { ok: true, message: "连接成功，Token 有效" }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401 || e.status === 403)
        return { ok: false, message: "Token 无效或已过期，请检查后重试" }
      return { ok: false, message: `服务器返回错误（${e.status}），请稍后重试` }
    }
    return { ok: false, message: "无法连接到服务器，请检查地址是否正确、网络是否可用" }
  }
}
