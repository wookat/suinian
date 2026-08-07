import { loadSettings } from "./settings"
import {
  mockAsk,
  mockCreateNote,
  mockDeleteNote,
  mockGetNote,
  mockGetNotes,
  mockGetReport,
  mockGetReports,
  mockGetThread,
  mockGetThreads,
  mockPatchNote,
} from "./mock"
import type {
  AskHistoryMessage,
  AskResponse,
  CreateNotePayload,
  Note,
  NotesQuery,
  NotesResponse,
  ReportsResponse,
  ThreadDetail,
  ThreadsResponse,
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

/** 图片上传：走 /api/ingest/media，后端提取文字/描述后入库 */
export async function ingestImage(file: File): Promise<Note> {
  if (loadSettings().useMock) {
    return mockCreateNote({ source: "web", raw_type: "image", content: `【图片】${file.name}（演示模式不做识别）` })
  }
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  const form = new FormData()
  form.set("type", "image")
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

export async function patchNote(
  id: string,
  patch: Partial<Pick<Note, "todo_done" | "category" | "tags" | "content">>,
): Promise<Note> {
  if (loadSettings().useMock) return mockPatchNote(id, patch)
  const body: Record<string, unknown> = { ...patch }
  if (patch.todo_done != null) body.todo_done = patch.todo_done === 1
  const res = await realFetch<Record<string, unknown>>(`/api/notes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
  return normalizeNote((res.note ?? res) as Record<string, unknown>)
}

export async function deleteNote(id: string): Promise<void> {
  if (loadSettings().useMock) return mockDeleteNote(id)
  await realFetch<{ ok: boolean }>(`/api/notes/${id}`, { method: "DELETE" })
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

async function authPost(baseUrl: string, path: string, body: unknown): Promise<AuthResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  return res.json() as Promise<AuthResult>
}

export function register(baseUrl: string, name: string, password: string): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/register", { name, password })
}

export function login(baseUrl: string, name: string, password: string): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/login", { name, password })
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
