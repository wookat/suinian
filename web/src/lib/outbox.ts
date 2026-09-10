/**
 * PWA 离线写入队列（R122 P1-3）：网络失败的速记进 IndexedDB 持久队列，
 * 网络恢复（window online）、应用启动、回到前台、登录/改地址时自动重放；
 * 浏览器在线但服务端 / 会话出故障（连接失败、429/5xx、401/403）时按退避
 * 定时重试，多条离线笔记全部保住，不再只剩输入框里的最后一条草稿。
 *
 * 选型：IndexedDB 是浏览器端唯一的结构化持久存储（localStorage 有 5MB 配额
 * 且同步阻塞）；Background Sync API 只有 Chromium 支持且 iOS PWA 不可用，
 * 用 online 事件 + 启动重放这一成熟组合覆盖全平台，不新增服务端实体。
 */
import { ApiError, createNote, ingestMedia, NetworkError } from "./api"
import { loadSettings, SETTINGS_CHANGED_EVENT } from "./settings"

/** 429/5xx 是服务端瞬时故障；401/403/408 是会话/时序问题（重新登录后能发出）。
 * 这些条目必须留队等下次重放，不能当毒丸丢弃（R302 P0-4：静默丢数据是
 * 收件箱产品的禁区，宁可留队也不丢）。 */
function isTransient(e: unknown): boolean {
  return (
    e instanceof NetworkError ||
    (e instanceof ApiError && (e.status === 429 || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 408))
  )
}
import type { CreateNotePayload, Note } from "./types"

const DB_NAME = "suinian-outbox"
const STORE = "notes"
/** v2 新增：离线录下的语音，Blob 持久存 IndexedDB，联网后走 /api/ingest/media 补传 */
const MEDIA_STORE = "media"

export interface OutboxItem {
  id?: number
  payload: CreateNotePayload
  queued_at: string
}

export interface MediaOutboxItem {
  id?: number
  blob: Blob
  type: "audio" | "image" | "file"
  fileName: string
  queued_at: string
  /** 入队时生成的幂等键：重放时服务端按它去重，响应丢失不会重复建笔记 */
  client_id?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true })
      }
      if (!req.result.objectStoreNames.contains(MEDIA_STORE)) {
        req.result.createObjectStore(MEDIA_STORE, { keyPath: "id", autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"))
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error("IndexedDB 操作失败"))
        t.oncomplete = () => db.close()
        t.onabort = () => db.close()
      }),
  )
}

type CountListener = (count: number) => void
const countListeners = new Set<CountListener>()
type FlushListener = (note: Note) => void
const flushListeners = new Set<FlushListener>()
// R302 P0-4：永久性拒绝（如 413 内容超长）导致的出队不再静默——把内容
// 交回 UI 展示，用户至少能看到并手动处理，绝不静默丢。
type DropListener = (label: string, reason: string) => void
const dropListeners = new Set<DropListener>()

/** 订阅被服务端永久拒绝而出队的条目（内容预览 + 原因）。 */
export function onOutboxDropped(listener: DropListener): () => void {
  dropListeners.add(listener)
  return () => dropListeners.delete(listener)
}

async function notifyCount(): Promise<void> {
  const count = await outboxCount().catch(() => 0)
  for (const l of countListeners) l(count)
}

/** 订阅待同步条数变化（含订阅时的当前值）；返回取消订阅函数。 */
export function onOutboxCount(listener: CountListener): () => void {
  countListeners.add(listener)
  void outboxCount()
    .then((c) => listener(c))
    .catch(() => {})
  return () => countListeners.delete(listener)
}

/** 订阅重放成功的笔记（时间线用它把补发的笔记插入列表）；返回取消订阅函数。 */
export function onOutboxFlushed(listener: FlushListener): () => void {
  flushListeners.add(listener)
  return () => flushListeners.delete(listener)
}

/** 排队条目的内容预览（R206 P3-3）：横幅可展开查看排队中的具体内容 */
export interface OutboxPreview {
  label: string
  queued_at: string
}

export async function outboxPreviews(): Promise<OutboxPreview[]> {
  const [notes, media] = await Promise.all([
    tx("readonly", (s) => s.getAll()) as Promise<OutboxItem[]>,
    tx("readonly", (s) => s.getAll(), MEDIA_STORE) as Promise<MediaOutboxItem[]>,
  ])
  const kind = { audio: "录音", image: "图片", file: "文件" } as const
  return [
    ...notes.map((n) => ({ label: n.payload.content, queued_at: n.queued_at })),
    ...media.map((m) => ({ label: `[${kind[m.type]}] ${m.fileName}`, queued_at: m.queued_at })),
  ].sort((a, b) => (a.queued_at < b.queued_at ? -1 : 1))
}

export async function outboxCount(): Promise<number> {
  const [notes, media] = await Promise.all([
    tx("readonly", (s) => s.count()),
    tx("readonly", (s) => s.count(), MEDIA_STORE),
  ])
  return notes + media
}

/** 网络失败的写入进队列；入队成功返回 true（失败时调用方退回输入框兜底）。 */
export async function enqueueNote(payload: CreateNotePayload): Promise<boolean> {
  try {
    // 入队即定幂等键：重放的响应丢失、或刷新后重放与上次重放叠加，服务端都按
    // client_id 返回已建笔记（R302 P0-4 生产实测重复建笔记的收口）。
    const withId: CreateNotePayload = { ...payload, client_id: payload.client_id ?? crypto.randomUUID() }
    await tx("readwrite", (s) => s.add({ payload: withId, queued_at: new Date().toISOString() }))
    void notifyCount()
    scheduleRetry()
    return true
  } catch {
    return false
  }
}

/** 离线媒体（图片/文件/录音）进队列；入队成功返回 true。 */
export async function enqueueMedia(blob: Blob, type: MediaOutboxItem["type"], fileName: string): Promise<boolean> {
  try {
    await tx("readwrite", (s) => s.add({ blob, type, fileName, queued_at: new Date().toISOString(), client_id: crypto.randomUUID() }), MEDIA_STORE)
    void notifyCount()
    scheduleRetry()
    return true
  } catch {
    return false
  }
}

let flushing = false

/** 在线但补发失败时的自动重试间隔：短起步、封顶 5 分钟；任一条成功、联网、设置变更即归零 */
const RETRY_BACKOFF_MS = [20_000, 40_000, 80_000, 160_000, 300_000]
let retryTimer: number | null = null
let retryAttempt = 0

function scheduleRetry(): void {
  if (retryTimer !== null) return
  // 离线不定时：等 online 事件
  if (typeof navigator !== "undefined" && navigator.onLine === false) return
  const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)]
  retryAttempt++
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    void flushOutbox()
  }, delay)
}

function resetRetry(): void {
  retryAttempt = 0
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
}

/**
 * 重放队列：逐条按入队顺序补发，成功即删；网络失败/429/5xx 立即停，离线等
 * online 事件、在线则按退避定时再试。队列里的是真实账号的记录，演示模式下不重放。文字笔记服务端按「内容+时间」去重，media 按入队时
 * 生成的 client_id 幂等，响应丢失导致的重复补发不会产生重复笔记。
 */
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  if (loadSettings().useMock) return
  flushing = true
  try {
    for (;;) {
      const items = (await tx("readonly", (s) => s.getAll())) as OutboxItem[]
      if (items.length === 0) break
      const item = items[0]
      try {
        const note = await createNote(item.payload)
        await tx("readwrite", (s) => s.delete(item.id!))
        retryAttempt = 0
        void notifyCount()
        for (const l of flushListeners) l(note)
      } catch (e) {
        if (isTransient(e)) {
          scheduleRetry()
          return
        }
        // 确定性 4xx（如内容超长被 413 拒绝）：这条永远发不出去，出队避免卡死
        // 整个队列，但内容交回 UI 展示（不静默丢），其余条目继续
        await tx("readwrite", (s) => s.delete(item.id!))
        void notifyCount()
        const reason = e instanceof Error ? e.message : String(e)
        for (const l of dropListeners) l(item.payload.content, reason)
      }
    }
    for (;;) {
      const items = (await tx("readonly", (s) => s.getAll(), MEDIA_STORE)) as MediaOutboxItem[]
      if (items.length === 0) break
      const item = items[0]
      try {
        const file = new File([item.blob], item.fileName, { type: item.blob.type || "application/octet-stream" })
        const note = await ingestMedia(file, item.type, item.client_id)
        await tx("readwrite", (s) => s.delete(item.id!), MEDIA_STORE)
        retryAttempt = 0
        void notifyCount()
        for (const l of flushListeners) l(note)
      } catch (e) {
        if (isTransient(e)) {
          scheduleRetry()
          return
        }
        await tx("readwrite", (s) => s.delete(item.id!), MEDIA_STORE)
        void notifyCount()
        const reason = e instanceof Error ? e.message : String(e)
        for (const l of dropListeners) l(item.fileName, reason)
      }
    }
  } finally {
    flushing = false
  }
}

let started = false

/** 应用启动时调用一次：立即重放存量 + 联网 / 回到前台 / 登录或改地址时自动重放。 */
export function startOutboxAutoFlush(): void {
  if (started) return
  started = true
  window.addEventListener("online", () => {
    resetRetry()
    void flushOutbox()
  })
  window.addEventListener(SETTINGS_CHANGED_EVENT, () => {
    resetRetry()
    void flushOutbox()
  })
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushOutbox()
  })
  void flushOutbox()
}
