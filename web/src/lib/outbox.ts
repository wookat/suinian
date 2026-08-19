/**
 * PWA 离线写入队列（R122 P1-3）：网络失败的速记进 IndexedDB 持久队列，
 * 网络恢复（window online）与应用启动时自动重放，多条离线笔记全部保住，
 * 不再只剩输入框里的最后一条草稿。
 *
 * 选型：IndexedDB 是浏览器端唯一的结构化持久存储（localStorage 有 5MB 配额
 * 且同步阻塞）；Background Sync API 只有 Chromium 支持且 iOS PWA 不可用，
 * 用 online 事件 + 启动重放这一成熟组合覆盖全平台，不新增服务端实体。
 */
import { ApiError, createNote, ingestMedia, NetworkError } from "./api"

/** 429/5xx 是服务端瞬时故障：条目必须留队等下次重放，不能当毒丸丢弃 */
function isTransient(e: unknown): boolean {
  return e instanceof NetworkError || (e instanceof ApiError && (e.status === 429 || e.status >= 500))
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
    await tx("readwrite", (s) => s.add({ payload, queued_at: new Date().toISOString() }))
    void notifyCount()
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
    return true
  } catch {
    return false
  }
}

let flushing = false

/**
 * 重放队列：逐条按入队顺序补发，成功即删；网络失败/429/5xx 立即停（留队列
 * 等下次 online 重放）。文字笔记服务端按「内容+时间」去重，media 按入队时
 * 生成的 client_id 幂等，响应丢失导致的重复补发不会产生重复笔记。
 */
export async function flushOutbox(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    for (;;) {
      const items = (await tx("readonly", (s) => s.getAll())) as OutboxItem[]
      if (items.length === 0) break
      const item = items[0]
      try {
        const note = await createNote(item.payload)
        await tx("readwrite", (s) => s.delete(item.id!))
        void notifyCount()
        for (const l of flushListeners) l(note)
      } catch (e) {
        if (isTransient(e)) return
        // 确定性 4xx（如内容超长被 413 拒绝）：这条永远发不出去，丢弃出队
        // 避免卡死整个队列，其余条目继续
        await tx("readwrite", (s) => s.delete(item.id!))
        void notifyCount()
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
        void notifyCount()
        for (const l of flushListeners) l(note)
      } catch (e) {
        if (isTransient(e)) return
        await tx("readwrite", (s) => s.delete(item.id!), MEDIA_STORE)
        void notifyCount()
      }
    }
  } finally {
    flushing = false
  }
}

let started = false

/** 应用启动时调用一次：立即重放存量 + 监听网络恢复自动重放。 */
export function startOutboxAutoFlush(): void {
  if (started) return
  started = true
  window.addEventListener("online", () => void flushOutbox())
  void flushOutbox()
}
