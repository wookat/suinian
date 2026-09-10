import { loadSettings } from "./settings"
import { identityFingerprint, isCacheableApiPath, withIdentityParam } from "./api-cache"
import { escapeSwWedgeForAuth } from "./sw-control"
import { mutated } from "./notes-bus"
import {
  mockAsk,
  mockCreateNote,
  mockDeleteNote,
  mockEmptyTrash,
  mockGetNote,
  mockGetTrash,
  mockPurgeNotes,
  mockRestoreNotes,
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
  PrevCategory,
  TagCount,
  StatsResponse,
  ReportsResponse,
  ThreadDetail,
  ThreadJob,
  ThreadsResponse,
  TrashResponse,
  TodayReviewResponse,
  WeeklyReport,
} from "./types"

/** 请求兜底超时：任何 GET/写请求悬挂（SW/网络中途卡住）都会转成可重试的
 * NetworkError，而不是让页面 skeleton 永远转下去。问答链路服务端上限 40s，
 * 这里取 60s 只兜真正的悬挂。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 交互 GET 收紧到 20s（R221 P1-1）：服务端读路径 P99 远低于 1s，挂满 20s 的
 * 只会是连接级悬挂，早断早重试优于白等。 */
const GET_TIMEOUT_MS = 20_000

async function realFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase()
  const budget = timeoutMs ?? (method === "GET" ? GET_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
  try {
    return await realFetchOnce<T>(path, init, budget)
  } catch (e) {
    // 幂等 GET 超时自动重试一次：连接级悬挂换一条连接即刻恢复（R221 复现均为
    // 重试即恢复）；写请求不自动重试（避免重复写，离线兜底走 outbox）
    if (method === "GET" && e instanceof NetworkError && e.timeout && !init?.signal?.aborted) {
      return realFetchOnce<T>(path, init, budget)
    }
    throw e
  }
}

async function realFetchOnce<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<T> {
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  // SW 会缓存这几条 GET 路由：URL 带上当前账号指纹，缓存按身份分区（R166 P1）
  const method = (init?.method ?? "GET").toUpperCase()
  const reqPath =
    method === "GET" && isCacheableApiPath(path)
      ? withIdentityParam(path, await identityFingerprint(apiToken))
      : path
  let res: Response
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}${reqPath}`, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...init?.headers,
      },
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError")
      throw new NetworkError("请求超时，请重试", true)
    if (e instanceof DOMException && e.name === "AbortError") {
      // AbortSignal.any 可能把超时也包装成 AbortError：调用方没主动取消时按超时处理
      if (init?.signal?.aborted) throw e
      if (timeoutSignal.aborted) throw new NetworkError("请求超时，请重试", true)
      throw e
    }
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

export class NetworkError extends Error {
  /** true = 请求超时（而非连接失败）：服务端预算已耗尽，自动重试大概率同样超时 */
  timeout: boolean
  constructor(message: string, timeout = false) {
    super(message)
    this.timeout = timeout
  }
}

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
  try {
    const res = await realFetch<{ note: Record<string, unknown> }>(`/api/notes/${encodeURIComponent(id)}`)
    return res.note ? normalizeNote(res.note) : null
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export function createNote(payload: CreateNotePayload): Promise<Note> {
  return mutated(createNoteRaw(payload))
}

async function createNoteRaw(payload: CreateNotePayload): Promise<Note> {
  if (loadSettings().useMock) return mockCreateNote(payload)
  const res = await realFetch<Record<string, unknown>>("/api/notes", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const raw = (res.note ?? res) as Record<string, unknown>
  return normalizeNote(raw)
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024

/** 上传前超限的统一友好文案（R154 P2-1）：明确上限 + 当前大小，Web/Android 同口径 */
export function mediaTooLargeText(kind: string, size: number): string {
  return `${kind}过大：最多 ${MAX_MEDIA_BYTES / 1024 / 1024}MB，当前约 ${(size / 1024 / 1024).toFixed(1)}MB`
}

export const SUPPORTED_FILE_EXTS = ["pdf", "txt", "md", "markdown", "docx", "csv", "tsv", "xlsx"]

/** 图片/文件/语音上传：走 /api/ingest/media，后端提取文字/转写/摘要后入库 */
export function ingestMedia(file: File, type: "image" | "file" | "audio", clientId?: string): Promise<Note> {
  return mutated(ingestMediaRaw(file, type, clientId))
}

async function ingestMediaRaw(file: File, type: "image" | "file" | "audio", clientId?: string): Promise<Note> {
  if (loadSettings().useMock) {
    return mockCreateNote({
      source: "web",
      raw_type: type === "audio" ? "voice" : type,
      content:
        type === "image"
          ? `【图片】${file.name}（演示模式不做识别）`
          : type === "audio"
            ? "【语音】录音已保存（演示模式不做转写）"
            : `【文件】${file.name}（演示模式不做提取）`,
    })
  }
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  const form = new FormData()
  form.set("type", type)
  form.set("source", "web")
  if (clientId) form.set("client_id", clientId)
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
// 鉴权媒体取件（R144 P1-1）：带 Bearer 拉取 /api/notes/:id/file 并转成 object URL，
// 按 note+attachment 缓存，避免重复下载；R2 保持私有，不暴露公链。
const mediaUrlCache = new Map<string, Promise<string>>()

export function fetchNoteMediaUrl(noteId: string, attachmentId?: string): Promise<string> {
  const key = `${noteId}:${attachmentId ?? ""}`
  const cached = mediaUrlCache.get(key)
  if (cached) return cached
  const p = (async () => {
    const { apiBaseUrl, apiToken, useMock } = loadSettings()
    if (useMock || !apiBaseUrl) throw new Error("演示模式不支持媒体预览")
    const qs = attachmentId ? `?inline=1&att=${encodeURIComponent(attachmentId)}` : "?inline=1"
    let res: Response
    try {
      res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/notes/${noteId}/file${qs}`, {
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
    return URL.createObjectURL(blob)
  })()
  mediaUrlCache.set(key, p)
  p.catch(() => mediaUrlCache.delete(key))
  return p
}

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

export function patchNote(id: string, patch: NotePatch, baseUpdatedAt?: string): Promise<Note> {
  return mutated(patchNoteRaw(id, patch, baseUpdatedAt))
}

async function patchNoteRaw(id: string, patch: NotePatch, baseUpdatedAt?: string): Promise<Note> {
  if (loadSettings().useMock) return mockPatchNote(id, patch)
  const body: Record<string, unknown> = { ...patch }
  if (patch.todo_done != null) body.todo_done = patch.todo_done === 1
  if (patch.is_sensitive != null) body.is_sensitive = patch.is_sensitive === 1
  // optimistic lock: the server rejects with 409 when the note changed since it was loaded
  if (baseUpdatedAt) body.base_updated_at = baseUpdatedAt
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

/** 原地重试语音转写/图片提取/文件解析（用 R2 存档的原件，无需重传），返回更新后的笔记 */
export async function retryMedia(id: string): Promise<Note> {
  if (loadSettings().useMock) throw new Error("演示模式不支持重试")
  const res = await realFetch<Record<string, unknown>>(`/api/notes/${id}/retry-media`, {
    method: "POST",
  })
  return normalizeNote((res.note ?? res) as Record<string, unknown>)
}

export function deleteNote(id: string): Promise<void> {
  return mutated(deleteNoteRaw(id))
}

async function deleteNoteRaw(id: string): Promise<void> {
  if (loadSettings().useMock) return mockDeleteNote(id)
  await realFetch<{ ok: boolean }>(`/api/notes/${id}`, { method: "DELETE" })
}

/** 撤销删除：清除软删标记，恢复笔记（服务端单次上限 1000，超出自动分批） */
export function restoreNotes(ids: string[]): Promise<number> {
  return mutated(restoreNotesRaw(ids))
}

async function restoreNotesRaw(ids: string[]): Promise<number> {
  if (loadSettings().useMock) return mockRestoreNotes(ids)
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

/** 最近删除列表：软删且未彻底清理的笔记（含剩余保留时间） */
export async function getTrash(): Promise<TrashResponse> {
  if (loadSettings().useMock) return mockGetTrash()
  const res = await realFetch<{ notes: Record<string, unknown>[]; retention_days: number }>("/api/notes/trash")
  return {
    notes: (res.notes ?? []).map((n) => ({
      ...normalizeNote(n),
      deleted_at: typeof n.deleted_at === "string" ? n.deleted_at : null,
      purge_at: typeof n.purge_at === "string" ? n.purge_at : null,
    })),
    retention_days: res.retention_days ?? 30,
  }
}

/** 立即彻底删除最近删除里的笔记（不可恢复） */
export function purgeNotes(ids: string[]): Promise<number> {
  return mutated(purgeNotesRaw(ids))
}

async function purgeNotesRaw(ids: string[]): Promise<number> {
  if (loadSettings().useMock) return mockPurgeNotes(ids)
  const res = await realFetch<{ ok: boolean; purged: number }>("/api/notes/purge", {
    method: "POST",
    body: JSON.stringify({ ids }),
  })
  return res.purged
}

/** 清空最近删除：彻底删除全部软删笔记（不可恢复） */
export function emptyTrash(): Promise<number> {
  return mutated(emptyTrashRaw())
}

async function emptyTrashRaw(): Promise<number> {
  if (loadSettings().useMock) return mockEmptyTrash()
  const res = await realFetch<{ ok: boolean; purged: number }>("/api/notes/trash/empty", {
    method: "POST",
    body: JSON.stringify({}),
  })
  return res.purged
}

/** 批量操作结果：affected=本次影响条数；remaining=筛选匹配超上限未处理条数；ids=删除时被软删的 id（供撤销）；prev=改分类时每条的原分类快照（供撤销） */
export interface BatchResult {
  affected: number
  remaining: number
  ids: string[]
  prev?: PrevCategory[]
}

/** NDJSON 批量流：{done,total} 进度行 + 最终 {ok,affected,remaining,ids?}（或 {error}） */
function batchStream(
  body: Record<string, unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  return mutated(batchStreamRaw(body, onProgress))
}

async function batchStreamRaw(
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
    let obj: { done?: number; total?: number; ok?: boolean; affected?: number; remaining?: number; ids?: string[]; prev?: PrevCategory[]; error?: string }
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    if (typeof obj.error === "string") throw new ApiError(500, obj.error)
    if (typeof obj.affected === "number")
      result = {
        affected: obj.affected,
        remaining: obj.remaining ?? 0,
        ids: Array.isArray(obj.ids) ? obj.ids : [],
        prev: Array.isArray(obj.prev) ? obj.prev : undefined,
      }
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

/** 批量操作：删除 / 加标签 / 去标签 / 改分类（进度经 onProgress 回调）。ids=实际变更的笔记 id（供撤销） */
export async function batchNotes(
  action: BatchAction,
  ids: string[],
  opts?: { tags?: string[]; category?: string },
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  return batchStream({ action, ids, ...opts }, onProgress)
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

/** 批量改分类的逆向恢复：按 prev 快照逐条恢复原分类与原手动标记位 */
export async function restoreCategories(
  entries: PrevCategory[],
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  return batchStream({ action: "restore_categories", entries }, onProgress)
}

/** 全部标签 + 使用次数（按次数降序） */
export async function getStats(days = 365, scope?: { tag?: string; scopeDays?: number }): Promise<StatsResponse> {
  if (loadSettings().useMock) return mockGetStats()
  const tz = -new Date().getTimezoneOffset()
  let qs = `/api/stats?days=${days}&tz_offset=${tz}`
  if (scope?.tag) qs += `&tag=${encodeURIComponent(scope.tag)}`
  if (scope?.scopeDays) qs += `&scope_days=${scope.scopeDays}`
  return realFetch<StatsResponse>(qs)
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
export function renameTag(from: string, to: string): Promise<number> {
  return mutated(
    realFetch<{ ok: boolean; affected: number }>("/api/tags/rename", {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }).then((res) => res.affected),
  )
}

/** 从所有笔记移除标签，返回影响的笔记数 */
export function deleteTag(tag: string): Promise<number> {
  return mutated(
    realFetch<{ ok: boolean; affected: number }>("/api/tags/delete", {
      method: "POST",
      body: JSON.stringify({ tag }),
    }).then((res) => res.affected),
  )
}

export async function ask(
  question: string,
  history: AskHistoryMessage[] = [],
): Promise<AskResponse> {
  if (loadSettings().useMock) return mockAsk(question)
  // 问答服务端预算上限 40s：单次等待 45s 就够，超时直接报错交给重试按钮，
  // 不自动重试叠加等待（避免用户盯着转圈两三分钟误以为卡死）
  const ASK_TIMEOUT_MS = 45_000
  const doAsk = () =>
    realFetch<AskResponse>("/api/ask", {
      method: "POST",
      body: JSON.stringify(history.length > 0 ? { question, history } : { question }),
    }, ASK_TIMEOUT_MS)
  let res: AskResponse
  try {
    res = await doAsk()
  } catch (e) {
    // 服务端瞬时故障/网络抖动自动重试一次；超时不自动重试（大概率同样超时，只会加倍等待）
    const transient = (e instanceof NetworkError && !e.timeout) || (e instanceof ApiError && (e.status === 503 || e.status >= 500))
    if (!transient) throw e
    await new Promise((r) => setTimeout(r, 1200))
    res = await doAsk()
  }
  return {
    ...res,
    notes: (res.notes ?? []).map((n) => normalizeNote(n as unknown as Record<string, unknown>)),
  }
}

/** askStream 的增量事件回调 */
export interface AskStreamHandlers {
  /** 服务端进度：phase=accepted 为请求已受理（检索前，retrieved 为 null），
   *  phase=retrieved 为检索完成（生成开始前）已找到 retrieved 条相关笔记 */
  onMeta?: (meta: { phase?: "accepted" | "retrieved"; retrieved: number | null }) => void
  /** 生成文本增量（正文尚未定稿，引证角标以最终 done 全文为准） */
  onDelta?: (text: string) => void
}

/**
 * 流式问答（R174，SSE）：带 Accept: text/event-stream 协商。确定性路由（财务/
 * 计数/枚举等）服务端仍整段 JSON 返回——按 content-type 识别直接解析；LLM 生成
 * 分支收 meta/delta 渐进渲染，done 事件携带引证补全后的最终全文 + references，
 * 调用方用返回值一次性替换流式中间态（保证引证角标确定性）。SSE 通道建立失败
 * （弱网/代理剥流）自动降级为普通 JSON 问答，行为与 ask() 一致。
 */
export async function askStream(
  question: string,
  history: AskHistoryMessage[] = [],
  handlers: AskStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AskResponse> {
  if (loadSettings().useMock) return mockAsk(question)
  const { apiBaseUrl, apiToken } = loadSettings()
  if (!apiBaseUrl) throw new Error("未配置 API Base URL，请到设置页填写或开启演示模式")
  // 流式预算按「空闲」计：只要正文持续流动就不中断（长笔记 verbatim 回显
  // 可能远超 60s），仅在 60s 无任何字节到达时才判定断流。
  const idleCtrl = new AbortController()
  let idleTimer = setTimeout(() => idleCtrl.abort(), 60_000)
  const touchIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => idleCtrl.abort(), 60_000)
  }
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/ask`, {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, idleCtrl.signal]) : idleCtrl.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(history.length > 0 ? { question, history } : { question }),
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError" && signal?.aborted) throw e
    // SSE 通道建立失败：降级为普通 JSON 问答（弱网/中间层不支持流式时不坏）
    return ask(question, history)
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
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream") || !res.body) {
    // 确定性路由整段 JSON（或中间层剥掉了流式）：直接按普通问答解析
    touchIdle()
    const data = (await res.json()) as AskResponse
    clearTimeout(idleTimer)
    return { ...data, notes: (data.notes ?? []).map((n) => normalizeNote(n as unknown as Record<string, unknown>)) }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let event = ""
  let done_: AskResponse | null = null
  let errMessage: string | null = null
  let errStatus = 500
  const handleLine = (line: string) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim()
      return
    }
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data) return
    try {
      if (event === "meta") handlers.onMeta?.(JSON.parse(data) as { phase?: "accepted" | "retrieved"; retrieved: number | null })
      else if (event === "delta") handlers.onDelta?.((JSON.parse(data) as { text: string }).text)
      else if (event === "done") done_ = JSON.parse(data) as AskResponse
      else if (event === "error") {
        const err = JSON.parse(data) as { message?: string; status?: number }
        errMessage = err.message ?? "生成失败，请重试"
        if (typeof err.status === "number") errStatus = err.status
      }
    } catch {
      // 忽略坏帧，done 缺失时统一在结尾兜底
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    touchIdle()
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) handleLine(line)
  }
  clearTimeout(idleTimer)
  handleLine(buf)
  if (errMessage) throw new ApiError(errStatus, errMessage)
  if (!done_) throw new NetworkError("流式回答中断，请重试", true)
  const final = done_ as AskResponse
  return { ...final, notes: (final.notes ?? []).map((n) => normalizeNote(n as unknown as Record<string, unknown>)) }
}

/** 导出/备份失败时把后端 JSON 错误体解析成可读文案，绝不把原始 JSON 直接给用户看 */
async function blobFetchError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "")
  let message = ""
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      message = (parsed as { error: string }).error
    }
  } catch {
    message = text
  }
  return new ApiError(res.status, message || `导出失败（HTTP ${res.status}），请稍后重试`)
}

export async function exportData(
  format: "json" | "markdown",
  includeSensitive: boolean,
  password?: string,
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
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(includeSensitive && password ? { "X-Suinian-Password": encodeURIComponent(password) } : {}),
      },
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) throw await blobFetchError(res)
  const blob = await res.blob()
  const date = new Date().toISOString().slice(0, 10)
  return { blob, filename: `suinian-export-${date}.${format === "markdown" ? "md" : "json"}` }
}

/** 下载完整备份 zip（notes.json 全字段 + media/ 原件 + manifest） */
export async function downloadBackup(includeSensitive: boolean, password?: string): Promise<{ blob: Blob; filename: string }> {
  const { apiBaseUrl, apiToken, useMock } = loadSettings()
  if (useMock || !apiBaseUrl) throw new Error("演示模式不支持备份，请先配置真实 API")
  const qs = includeSensitive ? "?include_sensitive=true" : ""
  let res: Response
  try {
    res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/backup${qs}`, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(includeSensitive && password ? { "X-Suinian-Password": encodeURIComponent(password) } : {}),
      },
    })
  } catch {
    throw new NetworkError("网络连接失败，请检查网络或 API 地址")
  }
  if (!res.ok) throw await blobFetchError(res)
  const blob = await res.blob()
  const date = new Date().toISOString().slice(0, 10)
  return { blob, filename: `suinian-backup-${date}${includeSensitive ? "-full" : ""}.zip` }
}

export interface RestoreStats {
  notes_total: number
  notes_imported: number
  notes_skipped: number
  /** 脱敏备份里的「[已加密内容]」占位壳：无明文可恢复，服务端跳过不导入 */
  sensitive_skipped: number
  /** 备份里的历史周报/月报导入条数 */
  reports_imported: number
  /** 同周期已存在或字段无效而跳过的报告条数 */
  reports_skipped: number
  /** 备份里的线索条数：不直接导入，由后台聚类重建 */
  threads_rebuilt: number
  media_imported: number
  media_skipped: number
  /** 单个文件超过大小上限，服务端主动跳过未导入 */
  media_oversized: number
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
  /** 图片资产超限被丢弃的数量（zip 导入） */
  assets_dropped?: number
  /** 达到单次 2000 条上限，超出部分未导入 */
  truncated?: boolean
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

/** 发起后台重建线索（异步）；若已有进行中任务则返回该任务 */
export async function startThreadRebuild(mode?: "similarity"): Promise<ThreadJob> {
  return realFetch<ThreadJob>("/api/threads/rebuild", {
    method: "POST",
    body: JSON.stringify(mode ? { mode } : {}),
  })
}

/** 查询后台重建任务进度 */
export async function getThreadRebuildJob(jobId: string): Promise<ThreadJob> {
  return realFetch<ThreadJob>(`/api/threads/rebuild/${encodeURIComponent(jobId)}`)
}

/** 查询最近一次重建任务（用于刷新页面后恢复进度条）；没有任务时返回 null */
export async function getLatestThreadRebuildJob(): Promise<ThreadJob | null> {
  try {
    return await realFetch<ThreadJob>("/api/threads/rebuild/latest")
  } catch {
    return null
  }
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

/**
 * 手动生成本周/本月报告（幂等：同期已有则重新生成覆盖）。
 * 空数据窗口（如周一凌晨的「本周」）返回 report: null + 引导文案，不是错误。
 */
export async function generateReport(
  which: "this" | "last" = "this",
  period: "week" | "month" = "week",
): Promise<{ report: WeeklyReport | null; message?: string }> {
  if (loadSettings().useMock) return { report: await mockGenerateReport() }
  const res = await realFetch<{ report: WeeklyReport | null; message?: string }>(
    "/api/reports/generate",
    {
      method: "POST",
      body: JSON.stringify({ week: which, which, period }),
    },
  )
  return { report: res.report ?? null, message: res.message }
}

/** 今日到期 + 已逾期的未完成待办（时间流顶部应用内提醒条） */
export async function getTodosToday(): Promise<{ date: string; items: (Note & { overdue: boolean })[] }> {
  if (loadSettings().useMock) return { date: "", items: [] }
  const res = await realFetch<{ date: string; items: Record<string, unknown>[] }>("/api/todos/today")
  return { date: res.date, items: res.items.map((r) => ({ ...normalizeNote(r), overdue: !!r.overdue })) }
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
  tz?: string | null
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

const TZ_SYNC_KEY = "suinian-tz-synced"

/** 把浏览器时区同步到服务端偏好（AI 分拣按用户时区理解“明天上午10点”）；只在变化时发请求 */
export async function syncTimezone(): Promise<void> {
  const { useMock, apiBaseUrl, apiToken } = loadSettings()
  if (useMock || !apiBaseUrl || !apiToken) return
  let tz: string
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return
  }
  if (!tz) return
  const marker = `${apiToken.slice(0, 8)}:${tz}`
  try {
    if (localStorage.getItem(TZ_SYNC_KEY) === marker) return
  } catch {
    /* storage unavailable: sync every load */
  }
  try {
    await updatePreferences({ tz })
    localStorage.setItem(TZ_SYNC_KEY, marker)
  } catch {
    /* non-fatal: retried on next load */
  }
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

export interface WechatBindingStatus {
  configured: boolean
  bound: boolean
  bindings: { openid_masked: string; created_at: string }[]
  /** 企微微信客服通道（R86）；旧后端可能不返回这些字段 */
  kf_configured?: boolean
  kf_bound?: boolean
  kf_bindings?: { openid_masked: string; created_at: string }[]
}

/** 微信公众号绑定状态（configured=false 表示服务端未配置公众号） */
export async function getWechatBinding(): Promise<WechatBindingStatus> {
  return realFetch<WechatBindingStatus>("/api/wechat/binding")
}

/**
 * 微信通道是否已开通（公众号或企微客服任一）。与设置页微信绑定卡同一来源
 * （/api/wechat/binding）；未登录、演示模式或请求失败一律按未开通处理（fail closed），
 * 供 tour 等入口文案统一判定，避免各处各写一套承诺。
 */
export async function isWechatConfigured(): Promise<boolean> {
  const s = loadSettings()
  if (s.useMock || !s.apiBaseUrl || !s.apiToken) return false
  try {
    const st = await getWechatBinding()
    return Boolean(st.configured || st.kf_configured)
  } catch {
    return false
  }
}

export async function createWechatBindCode(): Promise<{ code: string; expires_at: string; ttl_minutes: number }> {
  return realFetch<{ code: string; expires_at: string; ttl_minutes: number }>("/api/wechat/bind-code", { method: "POST" })
}

export async function unbindWechat(): Promise<void> {
  await realFetch<{ ok: boolean }>("/api/wechat/binding", { method: "DELETE" })
}

export interface AuthResult {
  user: { id: string; name: string }
  api_token: string
  /** 一次性恢复码：仅注册/找回成功时返回一次，服务端只存哈希 */
  recovery_code?: string | null
  /** 同名同密码幂等重试命中已有账号：本次是登录而非新建，不会有恢复码 */
  existing?: boolean
}

/** 登录/注册走 PBKDF2 + 冷启动，生产慢往返实测可超 30s（R189 P3-3）：
 * 超时窗与通用请求兜底对齐，只兜真正的悬挂 */
const AUTH_TIMEOUT_MS = 60_000
/** R282 F-8（audit-r281 §F-8）：生产间歇出现注册/登录 ~26–28s 才返回的窗口，
 * 而后端同期实测百毫秒级——症状是连接级悬挂（边缘/TLS/连接复用卡住），
 * 换一条新连接即刻恢复。注册/登录服务端幂等（同名同密码重试命中已有账号，
 * 不会重复建号），故首次尝试收紧到 15s，超时后立即换新连接重试一次，
 * 整体不超过原 60s 兜底。找回（recover）会消费一次性恢复码，不自动重试。 */
const AUTH_ATTEMPT_TIMEOUT_MS = 15_000

async function authPost(
  baseUrl: string,
  path: string,
  body: unknown,
  opts?: { retryOnTimeout?: boolean },
): Promise<AuthResult> {
  let res: Response
  try {
    res = await authFetchOnce(baseUrl, path, body, opts?.retryOnTimeout ? AUTH_ATTEMPT_TIMEOUT_MS : AUTH_TIMEOUT_MS)
  } catch (e) {
    if (opts?.retryOnTimeout && e instanceof DOMException && e.name === "TimeoutError") {
      // R288 P1-3：认证请求悬挂的一手定论是浏览器 SW 组件级悬挂（R287），
      // 原样重试只会再等一次。重试前先尝试脱开 SW 控制，让这一次 fetch 不再
      // 排在卡死的 SW 启动后面；脱不开（同样悬挂）也不阻塞，仍走原样重试。
      await escapeSwWedgeForAuth()
      try {
        res = await authFetchOnce(baseUrl, path, body, AUTH_TIMEOUT_MS - AUTH_ATTEMPT_TIMEOUT_MS)
      } catch (e2) {
        throw authFetchError(e2)
      }
    } else {
      throw authFetchError(e)
    }
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

function authFetchOnce(baseUrl: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

function authFetchError(e: unknown): NetworkError {
  if (e instanceof DOMException && e.name === "TimeoutError") {
    const wedged = typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller
    return new NetworkError(
      wedged
        ? "请求超时（浏览器离线缓存组件可能卡住）：请用相同用户名密码重试一次（不会重复创建账号）；仍失败可到设置页「关闭离线缓存」后重试"
        : "请求超时，请用相同用户名密码重试一次（不会重复创建账号）",
    )
  }
  return new NetworkError("网络连接失败，请检查网络或 API 地址")
}

export function register(baseUrl: string, name: string, password: string, inviteCode?: string): Promise<AuthResult> {
  const body: Record<string, string> = { name, password }
  if (inviteCode && inviteCode.trim()) body.invite_code = inviteCode.trim()
  return authPost(baseUrl, "/api/auth/register", body, { retryOnTimeout: true })
}

export interface RegisterPolicy {
  enabled: boolean
  invite_required: boolean
  quota_full: boolean
}

/** beta 注册策略（R318 D）：取不到时返回 null，前端按“开放注册”渲染，由服务端最终拒绝 */
export async function fetchRegisterPolicy(baseUrl: string): Promise<RegisterPolicy | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/auth/register-policy`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as Partial<RegisterPolicy>
    return {
      enabled: j.enabled !== false,
      invite_required: j.invite_required === true,
      quota_full: j.quota_full === true,
    }
  } catch {
    return null
  }
}

export function login(baseUrl: string, name: string, password: string): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/login", { name, password }, { retryOnTimeout: true })
}

/** 无密码找回：用户名 + 一次性恢复码 → 重置密码，返回新 token + 新恢复码 */
export function recoverAccount(
  baseUrl: string,
  name: string,
  recoveryCode: string,
  newPassword: string,
): Promise<AuthResult> {
  return authPost(baseUrl, "/api/auth/recover", {
    name,
    recovery_code: recoveryCode,
    new_password: newPassword,
  })
}

/** 重新生成恢复码（作废旧码），返回新码明文，仅展示一次 */
export async function regenerateRecoveryCode(): Promise<string> {
  const res = await realFetch<{ recovery_code: string }>("/api/auth/recovery-code", { method: "POST" })
  return res.recovery_code
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

/** 注销是幂等删除（服务端级联实测百毫秒级），挂满的只会是连接级悬挂。
 * R278 P1-6（audit-r277 §5：浏览器 40–60s 悬挂需 2–3 次重试，API 直连
 * 0.24s）：根因是 DELETE 与 401 探测复用同一条悬挂的 HTTP 连接——探测被
 * 同连接队头阻塞，并行探测形同虚设。修复：DELETE 预算收紧到 5s，探测
 * 加 cache-bust 查询参数迫使新请求（避开同 URL 合并/缓存），1.5s 一次，
 * 整体 ≤15s 内出确定结果（成功或可重试的错误），不再陪悬挂连接等 40s+。 */
export async function deleteAccount(): Promise<void> {
  // 幂等 DELETE 超时后换新请求重试（cache-bust 查询串迫使独立请求，避开
  // 悬挂连接/请求合并）：连接级悬挂换一条连接即刻恢复，最多共 3 次尝试
  let deleteFailed: unknown = null
  let attempt = 0
  const fireDelete = () => {
    attempt++
    deleteFailed = null
    return realFetch<{ ok: boolean }>(`/api/auth/me?attempt=${Date.now()}`, { method: "DELETE", cache: "no-store" }, 5_000)
      .then(() => true)
      .catch((e) => {
        deleteFailed = e
        return false
      })
  }
  let del = fireDelete()
  const deadline = Date.now() + 15_000
  for (;;) {
    const won = await Promise.race([
      del.then((ok) => (ok ? "done" : "failed")),
      new Promise<"tick">((r) => setTimeout(() => r("tick"), 1_500)),
    ])
    if (won === "done") return
    if (await verifyAccountDeleted()) return
    if (won === "failed") {
      const timedOut = deleteFailed instanceof NetworkError && (deleteFailed as NetworkError).timeout
      if (!timedOut) throw deleteFailed
      if (attempt < 3 && Date.now() < deadline - 3_000) {
        del = fireDelete()
        continue
      }
    }
    if (Date.now() > deadline) {
      if (deleteFailed) throw deleteFailed
      throw new NetworkError("注销请求超时，请重试", true)
    }
  }
}

/** 探测账号是否已被删除（token 失效 = 已删）；探测本身失败时保守返回 false。
 * cache-bust 参数迫使每次探测都是独立新请求，不被悬挂的 DELETE 同连接阻塞。 */
export async function verifyAccountDeleted(): Promise<boolean> {
  try {
    await realFetch<{ name: string }>(`/api/auth/me?probe=${Date.now()}`, { cache: "no-store" }, 3_000)
    return false
  } catch (e) {
    return e instanceof ApiError && e.status === 401
  }
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
