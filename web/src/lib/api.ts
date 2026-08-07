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

export async function patchNote(id: string, patch: NotePatch): Promise<Note> {
  if (loadSettings().useMock) return mockPatchNote(id, patch)
  const body: Record<string, unknown> = { ...patch }
  if (patch.todo_done != null) body.todo_done = patch.todo_done === 1
  if (patch.is_sensitive != null) body.is_sensitive = patch.is_sensitive === 1
  const res = await realFetch<Record<string, unknown>>(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
  return normalizeNote((res.note ?? res) as Record<string, unknown>)
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

/** 批量操作：删除 / 加标签 / 去标签 / 改分类（单次最多 100 条） */
export async function batchNotes(
  action: BatchAction,
  ids: string[],
  opts?: { tags?: string[]; category?: string },
): Promise<number> {
  if (loadSettings().useMock) throw new Error("演示模式不支持批量操作，请先配置真实 API")
  const res = await realFetch<{ ok: boolean; affected: number }>("/api/notes/batch", {
    method: "POST",
    body: JSON.stringify({ action, ids, ...opts }),
  })
  return res.affected
}

export interface BatchFilter {
  category?: string
  tag?: string
  q?: string
}

/** 按筛选条件批量操作全部匹配笔记（服务端执行，不限已加载项） */
export async function batchNotesByFilter(
  action: BatchAction,
  filter: BatchFilter,
  opts?: { tags?: string[]; category?: string },
): Promise<number> {
  if (loadSettings().useMock) throw new Error("演示模式不支持批量操作，请先配置真实 API")
  const res = await realFetch<{ ok: boolean; affected: number }>("/api/notes/batch", {
    method: "POST",
    body: JSON.stringify({ action, filter, ...opts }),
  })
  return res.affected
}

/** 全部标签 + 使用次数（按次数降序） */
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

export type ImportSource = "cubox" | "flomo" | "markdown" | "text"

export interface ImportStats {
  total: number
  imported: number
  skipped: number
  failed: number
}

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** 导入 Cubox / flomo / Markdown / 纯文本导出文件，批量入库 */
export async function importData(file: File, source: ImportSource): Promise<ImportStats> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持导入，请先配置真实 API")
  if (file.size > MAX_IMPORT_BYTES) throw new Error("文件过大：最大支持 20MB")
  const form = new FormData()
  form.set("source", source)
  form.set("file", file)
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/import`, {
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
  return res.json() as Promise<ImportStats>
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

/** 手动生成本周周报（幂等：本周已有则重新生成覆盖） */
export async function generateReport(week: "this" | "last" = "this"): Promise<WeeklyReport> {
  if (loadSettings().useMock) return mockGenerateReport()
  const res = await realFetch<{ report: WeeklyReport }>("/api/reports/generate", {
    method: "POST",
    body: JSON.stringify({ week }),
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
