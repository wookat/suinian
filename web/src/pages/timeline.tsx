import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Search,
  Sparkles,
  X,
  Loader2,
  RefreshCw,
  Plus,
  PenLine,
  SearchX,
  CheckSquare,
  Trash2,
  Tag,
  Eraser,
  FolderInput,
  SlidersHorizontal,
} from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { QuickInput } from "@/components/quick-input"
import { DailyReview } from "@/components/daily-review"
import { NoteCard } from "@/components/note-card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { getNotes, getNote, createNote, patchNote, deleteNote, restoreNotes, batchNotes, batchNotesByFilter, getThreads, ApiError, NetworkError } from "@/lib/api"
import type { BatchFilter } from "@/lib/api"
import { notifyNotesDeleted, notifyReviewRefresh } from "@/lib/review-bus"
import { loadSettings, useSettingsVersion } from "@/lib/settings"
import { FirstRunTour } from "@/components/first-run-tour"
import { cn, parseServerTime } from "@/lib/utils"
import type { Note, NoteCategory, NotePatch } from "@/lib/types"

// ask mode is opt-in: keep its chat UI out of the first-paint bundle
const AskChat = lazy(() => import("@/components/ask-chat").then((m) => ({ default: m.AskChat })))

const CATEGORY_OPTIONS: { value: NoteCategory; label: string }[] = [
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
]

const CATEGORY_TABS = [
  { value: "", label: "全部" },
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
] as const

const SAMPLE_TAG = "示例"
const SAMPLE_NOTES = [
  "周末想试试手冲咖啡，先从 V60 滤杯开始研究，豆子买浅烘的",
  "明天下午三点前给牙医回电话，预约洗牙",
  "https://github.com/wookat/suinian 碎念开源仓库，有空研究下自部署",
]

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部来源" },
  { value: "wechat", label: "微信" },
  { value: "web", label: "Web 速记" },
  { value: "android", label: "Android" },
  { value: "extension", label: "浏览器剪藏" },
  { value: "api", label: "API" },
  { value: "import", label: "导入" },
  { value: "from-ask", label: "问答存档" },
]

/** 本地日期（YYYY-MM-DD）转 UTC SQL 时间，与后端 created_at 存储格式对齐 */
function localDateToUtcSql(date: string, endOfDay: boolean): string | undefined {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return undefined
  const d = endOfDay
    ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59)
    : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

const TOP_TAGS = 12
const MOBILE_TOP_TAGS = 6
const SEARCH_DEBOUNCE_MS = 300
const POLL_INTERVAL = 2000
const POLL_MAX = 15
// 批量撤销：待撤销操作存 localStorage + 时间流顶部驻留撤销条，慢返回/刷新后窗口内仍可撤销
// （删除走服务端软删进「最近删除」，30 天后真删；标签操作记录实际变更的 ids 做逆操作）
const PENDING_UNDO_KEY = "suinian:pending-undo"
const PENDING_UNDO_TTL_MS = 5 * 60 * 1000

type PendingUndo = {
  kind: "restore" | "add_tags" | "remove_tags"
  ids: string[]
  tag?: string
  message: string
  expires: number
}

type LoadError =
  | { kind: "auth" }
  | { kind: "network" }
  | { kind: "other"; message: string }

function dayLabel(iso: string): string {
  const d = parseServerTime(iso)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400_000,
  )
  if (diffDays === 0) return "今天"
  if (diffDays === 1) return "昨天"
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
  return d.getFullYear() === now.getFullYear() ? date : `${d.getFullYear()}年${date}`
}

export function TimelinePage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadError | null>(null)
  const [category, setCategory] = useState("")
  const [tag, setTag] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [askMode, setAskMode] = useState(false)
  // ? 内联指令：速记框直接提问 → 打开问答面板并发送
  const [askPrefill, setAskPrefill] = useState<string | null>(null)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [mobileTagsExpanded, setMobileTagsExpanded] = useState(false)
  const [debouncing, setDebouncing] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set())
  const abortRef = useRef<AbortController | null>(null)
  const pollersRef = useRef<Map<string, number>>(new Map())
  const quickInputRef = useRef<HTMLDivElement>(null)
  const settingsVersion = useSettingsVersion()
  // 新注册用户首次进入时间流：一次性功能引导
  const [showTour, setShowTour] = useState(() => {
    const s = loadSettings()
    return !s.useMock && !!s.apiToken && !s.tourSeen
  })
  const [seeding, setSeeding] = useState(false)

  // 多选批量操作
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  // “选中全部匹配结果”：服务端按当前筛选条件执行，不限已加载项
  const [allMatching, setAllMatching] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  const [tagPanelMode, setTagPanelMode] = useState<"add" | "remove">("add")
  const [catPanelOpen, setCatPanelOpen] = useState(false)
  const [batchTagInput, setBatchTagInput] = useState("")
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<"all" | "selected" | null>(null)
  const [toast, setToast] = useState<{ message: string; undo?: () => void; undoLabel?: string } | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  // 驻留撤销条：不随 toast 自动消失，撤销/关闭/过期才走
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)
  const pendingUndoTimerRef = useRef<number | null>(null)

  const showToast = useCallback((message: string, undo?: () => void, ms = 6000, undoLabel?: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ message, undo, undoLabel })
    toastTimerRef.current = window.setTimeout(() => setToast(null), ms)
  }, [])

  const clearPendingUndo = useCallback(() => {
    if (pendingUndoTimerRef.current !== null) window.clearTimeout(pendingUndoTimerRef.current)
    pendingUndoTimerRef.current = null
    setPendingUndo(null)
    try {
      localStorage.removeItem(PENDING_UNDO_KEY)
    } catch {
      // ignore
    }
  }, [])

  // 批量操作后驻留撤销条并写 localStorage：慢返回、刷新后窗口内仍可撤销
  const showPendingUndo = useCallback((p: Omit<PendingUndo, "expires"> & { expires?: number }) => {
    const undo: PendingUndo = { ...p, expires: p.expires ?? Date.now() + PENDING_UNDO_TTL_MS }
    try {
      localStorage.setItem(PENDING_UNDO_KEY, JSON.stringify(undo))
    } catch {
      // storage full/unavailable: undo still works until the bar expires
    }
    setPendingUndo(undo)
    if (pendingUndoTimerRef.current !== null) window.clearTimeout(pendingUndoTimerRef.current)
    pendingUndoTimerRef.current = window.setTimeout(() => {
      pendingUndoTimerRef.current = null
      setPendingUndo(null)
      try {
        localStorage.removeItem(PENDING_UNDO_KEY)
      } catch {
        // ignore
      }
    }, Math.max(0, undo.expires - Date.now()))
  }, [])

  const performUndo = useCallback(
    (p: PendingUndo) => {
      clearPendingUndo()
      void (async () => {
        if (p.kind === "restore") {
          const n = await restoreNotes(p.ids)
          showToast(`已恢复 ${n} 条`)
        } else if (p.kind === "add_tags") {
          await batchNotes("remove_tags", p.ids, { tags: [p.tag ?? ""] })
          showToast(`已撤销：从 ${p.ids.length} 条移除 #${p.tag}`)
        } else {
          await batchNotes("add_tags", p.ids, { tags: [p.tag ?? ""] })
          showToast(`已撤销：为 ${p.ids.length} 条补回 #${p.tag}`)
        }
        void load()
        notifyReviewRefresh()
      })().catch((e) => showToast(e instanceof Error ? e.message : String(e)))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearPendingUndo, showToast],
  )

  const showUndoDeleteToast = useCallback(
    (ids: string[], message: string) => showPendingUndo({ kind: "restore", ids, message }),
    [showPendingUndo],
  )

  // 刷新后恢复未过期的撤销条（批量操作→刷新→撤销仍可用）
  useEffect(() => {
    type Saved = { kind?: unknown; ids?: unknown; tag?: unknown; message?: unknown; expires?: unknown }
    let saved: Saved | null = null
    try {
      const raw = localStorage.getItem(PENDING_UNDO_KEY)
      if (raw) saved = JSON.parse(raw) as Saved
    } catch {
      saved = null
    }
    if (!saved) return
    const ids = Array.isArray(saved.ids) ? saved.ids.filter((v): v is string => typeof v === "string") : []
    const expires = typeof saved.expires === "number" ? saved.expires : 0
    const kind =
      saved.kind === "add_tags" || saved.kind === "remove_tags" ? saved.kind : "restore"
    const tag = typeof saved.tag === "string" ? saved.tag : undefined
    if (ids.length === 0 || expires <= Date.now() || (kind !== "restore" && !tag)) {
      try {
        localStorage.removeItem(PENDING_UNDO_KEY)
      } catch {
        // ignore
      }
      return
    }
    showPendingUndo({
      kind,
      ids,
      tag,
      message: typeof saved.message === "string" ? saved.message : `已删除 ${ids.length} 条`,
      expires,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      if (pendingUndoTimerRef.current !== null) window.clearTimeout(pendingUndoTimerRef.current)
    }
  }, [])

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
    setAllMatching(false)
    setTagPanelOpen(false)
    setCatPanelOpen(false)
  }

  const currentFilter = useCallback((): BatchFilter => {
    const f: BatchFilter = {}
    if (category) f.category = category
    if (tag) f.tag = tag
    if (search) f.q = search
    if (sourceFilter) f.source = sourceFilter
    if (fromDate) f.from = localDateToUtcSql(fromDate, false)
    if (toDate) f.to = localDateToUtcSql(toDate, true)
    return f
  }, [category, tag, search, sourceFilter, fromDate, toDate])

  function toggleSelected(note: Note) {
    setAllMatching(false)
    setSelectedIds((ids) => {
      const next = new Set(ids)
      if (next.has(note.id)) next.delete(note.id)
      else next.add(note.id)
      return next
    })
  }

  // 移除标签面板的候选：选中笔记里出现过的标签（按出现次数降序）
  const selectedTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of notes) {
      if (!selectedIds.has(n.id)) continue
      for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t)
      .slice(0, 12)
  }, [notes, selectedIds])

  function batchDelete() {
    if (allMatching) {
      setConfirmDelete("all")
      return
    }
    if (selectedIds.size === 0) return
    setConfirmDelete("selected")
  }

  function runBatchDelete(kind: "all" | "selected") {
    const onProgress = (done: number, total: number) => setBatchProgress({ done, total })
    if (kind === "all") {
      setBatchBusy(true)
      setBatchProgress(null)
      // 服务端单次上限 1000 条：自动续删到全部匹配清完，累计 ids 供一次性撤销
      void (async () => {
        const allIds: string[] = []
        let base = 0
        let extraRemaining = 0
        for (;;) {
          const res = await batchNotesByFilter("delete", currentFilter(), undefined, (done, total) =>
            setBatchProgress({ done: base + done, total: base + total + extraRemaining }),
          )
          allIds.push(...res.ids)
          base += res.affected
          extraRemaining = res.remaining
          if (res.remaining <= 0 || res.affected === 0) break
          showToast(`已删除前 ${base} 条，剩余 ${res.remaining} 条，正在继续删除…`)
        }
        exitSelectMode()
        if (allIds.length > 0) {
          notifyNotesDeleted(allIds)
          showUndoDeleteToast(allIds, `已删除全部匹配的 ${base} 条`)
        } else {
          showToast("没有可删除的匹配碎念")
        }
      })()
        .catch((e) => showToast(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          setBatchBusy(false)
          setBatchProgress(null)
          void load()
          notifyReviewRefresh()
        })
      return
    }
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setBatchBusy(true)
    setBatchProgress(null)
    void batchNotes("delete", ids, undefined, onProgress)
      .then((res) => {
        setNotes((ns) => ns.filter((n2) => !selectedIds.has(n2.id)))
        exitSelectMode()
        notifyNotesDeleted(ids)
        showUndoDeleteToast(ids, `已删除 ${res.affected} 条`)
      })
      .catch((e) => {
        showToast(e instanceof Error ? e.message : String(e))
        void load()
      })
      .finally(() => {
        setBatchBusy(false)
        setBatchProgress(null)
      })
  }

  async function batchAddTag() {
    const tag = batchTagInput.trim().replace(/^#/, "")
    const ids = [...selectedIds]
    if (!tag || (!allMatching && ids.length === 0)) return
    setBatchBusy(true)
    if (allMatching) {
      try {
        const res = await batchNotesByFilter("add_tags", currentFilter(), { tags: [tag] }, (done, total) =>
          setBatchProgress({ done, total }),
        )
        setBatchTagInput("")
        setTagPanelOpen(false)
        exitSelectMode()
        const msg =
          res.remaining > 0
            ? `已为前 ${res.affected} 条加上 #${tag}，剩余 ${res.remaining} 条请再次执行`
            : `已为全部匹配的 ${res.affected} 条加上 #${tag}`
        if (res.ids.length > 0) showPendingUndo({ kind: "add_tags", ids: res.ids, tag, message: msg })
        else showToast(msg)
        void load()
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      } finally {
        setBatchBusy(false)
        setBatchProgress(null)
      }
      return
    }
    try {
      const res = await batchNotes("add_tags", ids, { tags: [tag] }, (done, total) => setBatchProgress({ done, total }))
      setNotes((ns) =>
        ns.map((n) => (selectedIds.has(n.id) && !n.tags.includes(tag) ? { ...n, tags: [...n.tags, tag] } : n)),
      )
      setBatchTagInput("")
      setTagPanelOpen(false)
      exitSelectMode()
      const changed = res.ids.length > 0 ? res.ids : ids
      showPendingUndo({ kind: "add_tags", ids: changed, tag, message: `已为 ${ids.length} 条加上 #${tag}` })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
      setBatchProgress(null)
    }
  }

  async function batchRemoveTag(tagName?: string) {
    const tag = (tagName ?? batchTagInput).trim().replace(/^#/, "")
    const ids = [...selectedIds]
    if (!tag || (!allMatching && ids.length === 0)) return
    setBatchBusy(true)
    if (allMatching) {
      try {
        const res = await batchNotesByFilter("remove_tags", currentFilter(), { tags: [tag] }, (done, total) =>
          setBatchProgress({ done, total }),
        )
        setBatchTagInput("")
        setTagPanelOpen(false)
        exitSelectMode()
        const msg =
          res.remaining > 0
            ? `已从前 ${res.affected} 条移除 #${tag}，剩余 ${res.remaining} 条请再次执行`
            : `已从全部匹配的 ${res.affected} 条移除 #${tag}`
        if (res.ids.length > 0) showPendingUndo({ kind: "remove_tags", ids: res.ids, tag, message: msg })
        else showToast(msg)
        void load()
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      } finally {
        setBatchBusy(false)
        setBatchProgress(null)
      }
      return
    }
    // 撤销只补回原本就有该标签的那些笔记（服务端回传实际变更的 ids）
    const hadTagIds = notes.filter((n) => selectedIds.has(n.id) && n.tags.includes(tag)).map((n) => n.id)
    try {
      const res = await batchNotes("remove_tags", ids, { tags: [tag] }, (done, total) => setBatchProgress({ done, total }))
      setNotes((ns) =>
        ns.map((n) => (selectedIds.has(n.id) ? { ...n, tags: n.tags.filter((t) => t !== tag) } : n)),
      )
      setBatchTagInput("")
      setTagPanelOpen(false)
      exitSelectMode()
      const changed = res.ids.length > 0 ? res.ids : hadTagIds
      if (changed.length > 0)
        showPendingUndo({ kind: "remove_tags", ids: changed, tag, message: `已从 ${changed.length} 条移除 #${tag}` })
      else showToast(`选中笔记都没有 #${tag}`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
      setBatchProgress(null)
    }
  }

  async function batchSetCategory(cat: NoteCategory) {
    const ids = [...selectedIds]
    if (!allMatching && ids.length === 0) return
    setBatchBusy(true)
    if (allMatching) {
      try {
        const res = await batchNotesByFilter("set_category", currentFilter(), { category: cat }, (done, total) =>
          setBatchProgress({ done, total }),
        )
        setCatPanelOpen(false)
        exitSelectMode()
        const label = CATEGORY_OPTIONS.find((c) => c.value === cat)?.label ?? cat
        showToast(
          res.remaining > 0
            ? `已将前 ${res.affected} 条改为「${label}」，剩余 ${res.remaining} 条请再次执行`
            : `已将全部匹配的 ${res.affected} 条改为「${label}」`,
        )
        void load()
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e))
      } finally {
        setBatchBusy(false)
        setBatchProgress(null)
      }
      return
    }
    const previous = notes
      .filter((n) => selectedIds.has(n.id))
      .map((n) => ({ id: n.id, category: n.category }))
    try {
      await batchNotes("set_category", ids, { category: cat }, (done, total) => setBatchProgress({ done, total }))
      setNotes((ns) => ns.map((n) => (selectedIds.has(n.id) ? { ...n, category: cat } : n)))
      setCatPanelOpen(false)
      exitSelectMode()
      const label = CATEGORY_OPTIONS.find((c) => c.value === cat)?.label ?? cat
      showToast(`已将 ${ids.length} 条改为「${label}」`, () => {
        void Promise.allSettled(
          previous.filter((p) => p.category).map((p) => patchNote(p.id, { category: p.category! })),
        ).then(() => void load())
        setToast(null)
      })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
      setBatchProgress(null)
    }
  }

  async function seedSamples() {
    if (seeding) return
    setSeeding(true)
    try {
      for (const content of SAMPLE_NOTES) {
        const note = await createNote({ source: "web", raw_type: "text", content, tags: [SAMPLE_TAG] })
        handleCreated(note)
      }
      showToast(`已丢入 ${SAMPLE_NOTES.length} 条示例，AI 正在自动分拣…`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSeeding(false)
    }
  }

  const sampleIds = useMemo(() => notes.filter((n) => n.tags.includes(SAMPLE_TAG)).map((n) => n.id), [notes])

  async function clearSamples() {
    const ids = sampleIds
    if (ids.length === 0) return
    try {
      await batchNotes("delete", ids)
      setNotes((ns) => ns.filter((n) => !ids.includes(n.id)))
      notifyNotesDeleted(ids)
      showToast(`已清除 ${ids.length} 条示例笔记`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    }
  }

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const res = await getNotes(
        {
          category: category || undefined,
          tag: tag || undefined,
          q: search || undefined,
          source: sourceFilter || undefined,
          from: fromDate ? localDateToUtcSql(fromDate, false) : undefined,
          to: toDate ? localDateToUtcSql(toDate, true) : undefined,
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setNotes(res.notes)
      setCursor(res.cursor)
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return
      if (controller.signal.aborted) return
      if (e instanceof ApiError && (e.status === 401 || e.status === 403))
        setError({ kind: "auth" })
      else if (e instanceof NetworkError) setError({ kind: "network" })
      else setError({ kind: "other", message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [category, tag, search, sourceFilter, fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || loading) return
    setLoadingMore(true)
    try {
      const res = await getNotes({
        category: category || undefined,
        tag: tag || undefined,
        q: search || undefined,
        source: sourceFilter || undefined,
        from: fromDate ? localDateToUtcSql(fromDate, false) : undefined,
        to: toDate ? localDateToUtcSql(toDate, true) : undefined,
        cursor,
      })
      setNotes((ns) => {
        const seen = new Set(ns.map((n) => n.id))
        return [...ns, ...res.notes.filter((n) => !seen.has(n.id))]
      })
      setCursor(res.cursor)
    } catch {
      // 滚动加载失败静默处理，下次进入视口重试
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore, loading, category, tag, search, sourceFilter, fromDate, toDate])

  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreRef.current()
      },
      { rootMargin: "400px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading])

  useEffect(() => {
    const applyHashTag = () => {
      const query = window.location.hash.split("?")[1]
      if (!query) return
      const params = new URLSearchParams(query)
      const t = params.get("tag")
      const d = params.get("date")
      if (t) setTag(t)
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        setFromDate(d)
        setToDate(d)
        setFiltersOpen(true)
      }
      if (t || d) history.replaceState(null, "", `${window.location.pathname}#/`)
    }
    applyHashTag()
    window.addEventListener("hashchange", applyHashTag)
    return () => window.removeEventListener("hashchange", applyHashTag)
  }, [])

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    }
  }, [])

  useEffect(() => {
    const pollers = pollersRef.current
    return () => {
      for (const t of pollers.values()) window.clearTimeout(t)
      pollers.clear()
    }
  }, [])

  const pollTriage = useCallback((id: string, attempt = 0) => {
    if (attempt >= POLL_MAX) {
      pollersRef.current.delete(id)
      return
    }
    const t = window.setTimeout(() => {
      void getNote(id)
        .then((fresh) => {
          if (fresh && fresh.category !== null) {
            pollersRef.current.delete(id)
            setNotes((ns) => ns.map((n) => (n.id === id ? fresh : n)))
          } else {
            pollTriage(id, attempt + 1)
          }
        })
        .catch(() => pollTriage(id, attempt + 1))
    }, POLL_INTERVAL)
    pollersRef.current.set(id, t)
  }, [])

  const handleCreated = useCallback(
    (note: Note) => {
      setNewIds((ids) => new Set(ids).add(note.id))
      setNotes((ns) => [note, ...ns])
      if (note.category === null) pollTriage(note.id)
    },
    [pollTriage],
  )

  // 线索标题映射：整个时间流只拉一次 /api/threads，卡片只消费映射结果
  const [threadTitles, setThreadTitles] = useState<Map<string, string>>(() => new Map())
  const threadsFetchedRef = useRef(false)
  useEffect(() => {
    if (threadsFetchedRef.current) return
    if (!notes.some((n) => n.thread_id)) return
    threadsFetchedRef.current = true
    void getThreads()
      .then((res) => setThreadTitles(new Map(res.threads.map((t) => [t.id, t.title]))))
      .catch(() => {
        threadsFetchedRef.current = false // 失败不影响时间流，下次有机会再试
      })
  }, [notes])

  const allTags = useMemo(() => {
    const count = new Map<string, number>()
    for (const n of notes)
      for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)
  }, [notes])

  const grouped = useMemo(() => {
    const groups: { label: string; notes: Note[] }[] = []
    for (const n of notes) {
      const label = dayLabel(n.created_at)
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.notes.push(n)
      else groups.push({ label, notes: [n] })
    }
    return groups
  }, [notes])

  async function toggleTodo(note: Note) {
    const next = note.todo_done === 1 ? 0 : 1
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, todo_done: next } : n)))
    try {
      await patchNote(note.id, { todo_done: next })
    } catch {
      setNotes((ns) =>
        ns.map((n) => (n.id === note.id ? { ...n, todo_done: note.todo_done } : n)),
      )
    }
  }

  async function handleEdit(note: Note, patch: NotePatch) {
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, ...patch } : n)))
    try {
      const fresh = await patchNote(note.id, patch)
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
    } catch (e) {
      setNotes((ns) => ns.map((n) => (n.id === note.id ? note : n)))
      showToast(
        `保存失败：${e instanceof Error ? e.message : String(e)}`,
        () => {
          setToast(null)
          void handleEdit(note, patch)
        },
        10000,
        "重试",
      )
    }
  }

  async function handleToggleSensitive(note: Note) {
    const next = note.is_sensitive === 1 ? 0 : 1
    try {
      const fresh = await patchNote(note.id, { is_sensitive: next })
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
    } catch {
      // keep original note on failure
    }
  }

  async function handleDelete(note: Note) {
    const prev = notes
    setNotes((ns) => ns.filter((n) => n.id !== note.id))
    notifyNotesDeleted([note.id])
    try {
      await deleteNote(note.id)
      showUndoDeleteToast([note.id], "已删除 1 条")
    } catch {
      setNotes(prev)
      notifyReviewRefresh()
    }
  }

  const visibleTags = tagsExpanded ? allTags : allTags.slice(0, TOP_TAGS)
  const hiddenCount = allTags.length - TOP_TAGS

  return (
    <div className="space-y-4">
      {showTour && <FirstRunTour onDone={() => setShowTour(false)} />}

      {/* 驻留撤销条：批量操作后顶部常驻（5 分钟），慢返回/刷新后仍可撤销 */}
      {pendingUndo && (
        <div className="sticky top-2 z-30">
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-popover px-4 py-2.5 text-sm shadow-md animate-in fade-in slide-in-from-top-2">
            <span className="min-w-0 truncate">{pendingUndo.message}</span>
            <div className="flex shrink-0 items-center gap-3">
              <button
                onClick={() => performUndo(pendingUndo)}
                className="font-medium text-primary hover:underline"
              >
                撤销
              </button>
              <button
                onClick={clearPendingUndo}
                aria-label="关闭撤销提示"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <DailyReview onTagClick={setTag} />

      <div ref={quickInputRef}>
        <QuickInput
          onCreated={handleCreated}
          onAsk={(q) => {
            setAskMode(true)
            setAskPrefill(q)
          }}
        />
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              const value = e.target.value
              setSearchInput(value)
              if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
              if (value.trim() === search) {
                setDebouncing(false)
                return
              }
              setDebouncing(true)
              debounceRef.current = window.setTimeout(() => {
                setDebouncing(false)
                setSearch(value.trim())
              }, SEARCH_DEBOUNCE_MS)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
                setDebouncing(false)
                setSearch(searchInput.trim())
              }
            }}
            placeholder="搜索笔记…"
            className="pl-8"
          />
          {(debouncing || (loading && search !== "")) && (
            <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <Button
          variant={askMode ? "default" : "outline"}
          size="sm"
          className="h-9"
          onClick={() => setAskMode((m) => !m)}
        >
          <Sparkles />
          问答
        </Button>
        <Button
          variant={selectMode ? "default" : "outline"}
          size="sm"
          className="h-9"
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
        >
          <CheckSquare />
          {selectMode ? "退出选择" : "选择"}
        </Button>
        <Button
          variant={filtersOpen || !!sourceFilter || !!fromDate || !!toDate ? "default" : "outline"}
          size="sm"
          className="h-9 px-2.5"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-label="筛选"
          title="按来源/时间筛选"
        >
          <SlidersHorizontal />
        </Button>
      </div>

      {filtersOpen && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            aria-label="来源筛选"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="开始日期"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label="结束日期"
            />
          </div>
          {(sourceFilter || fromDate || toDate) && (
            <button
              onClick={() => {
                setSourceFilter("")
                setFromDate("")
                setToDate("")
              }}
              className="inline-flex items-center gap-0.5 text-xs font-medium text-primary underline underline-offset-2"
            >
              <X className="size-3" /> 清除筛选
            </button>
          )}
        </div>
      )}

      {askMode && (
        <Suspense fallback={null}>
          <AskChat
            onTagClick={setTag}
            initialQuestion={askPrefill}
            onInitialQuestionConsumed={() => setAskPrefill(null)}
          />
        </Suspense>
      )}

      <div className="flex gap-1 overflow-x-auto pb-1">
        {CATEGORY_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setCategory(t.value)}
            className={cn(
              "shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              category === t.value
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tag && (
            <Badge className="cursor-pointer" onClick={() => setTag("")}>
              #{tag} <X className="ml-0.5 size-3" />
            </Badge>
          )}
          {visibleTags
            .filter((t) => t !== tag)
            .map((t, i) => (
              <Badge
                key={t}
                variant="outline"
                className={cn(
                  "cursor-pointer hover:bg-accent",
                  !mobileTagsExpanded && i >= MOBILE_TOP_TAGS && "hidden md:inline-flex",
                )}
                onClick={() => setTag(t)}
              >
                #{t}
              </Badge>
            ))}
          {visibleTags.filter((t) => t !== tag).length > MOBILE_TOP_TAGS && (
            <button
              onClick={() => setMobileTagsExpanded((x) => !x)}
              className="text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
            >
              {mobileTagsExpanded
                ? "收起"
                : `展开（${visibleTags.filter((t) => t !== tag).length - MOBILE_TOP_TAGS}）`}
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              onClick={() => setTagsExpanded((x) => !x)}
              className="hidden text-xs font-medium text-muted-foreground hover:text-foreground md:inline"
            >
              {tagsExpanded ? "收起" : `更多（${hiddenCount}）`}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <NoteListSkeleton />
      ) : error ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          {error.kind === "auth" ? (
            <>
              <p className="text-sm text-muted-foreground">
                登录已失效或 Token 不正确，无法读取你的碎念。
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  window.location.hash = "#/settings"
                }}
              >
                去设置检查 Token
              </Button>
            </>
          ) : error.kind === "network" ? (
            <>
              <p className="text-sm text-muted-foreground">
                网络连接失败，请检查网络后重试。
              </p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="size-3.5" /> 重试
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-destructive">{error.message}</p>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="size-3.5" /> 重试
              </Button>
            </>
          )}
        </Card>
      ) : notes.length === 0 ? (
        search || tag || category ? (
          <EmptyState
            icon={SearchX}
            title="没有找到匹配的笔记"
            description="换个关键词、标签或分类试试，或清除筛选条件查看全部碎念。"
            actionLabel="清除筛选"
            onAction={() => {
              setCategory("")
              setTag("")
              setSearchInput("")
              setSearch("")
            }}
            secondaryActionLabel={search ? "用 AI 问问看" : undefined}
            onSecondaryAction={
              search
                ? () => {
                    setAskMode(true)
                    setAskPrefill(search)
                    window.scrollTo({ top: 0, behavior: "smooth" })
                  }
                : undefined
            }
          />
        ) : (
          <Card className="flex flex-col items-center gap-3 p-10 text-center animate-in fade-in duration-300">
            <span className="flex size-14 items-center justify-center rounded-full bg-accent">
              <PenLine className="size-7 text-accent-foreground" />
            </span>
            <h2 className="text-base font-medium">还没有碎念</h2>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              想法、待办、链接、资料，想到什么就丢进来，AI 会帮你自动分拣整理。
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  quickInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
                  quickInputRef.current?.querySelector("textarea")?.focus()
                }}
              >
                <PenLine /> 记下第一条
              </Button>
              <Button size="sm" variant="outline" disabled={seeding} onClick={() => void seedSamples()}>
                {seeding ? <Loader2 className="animate-spin" /> : <Sparkles />}
                先丢入 {SAMPLE_NOTES.length} 条示例看看
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">示例会打上 #{SAMPLE_TAG} 标签，可随时一键清除</p>
          </Card>
        )
      ) : (
        <div className="space-y-4">
          {sampleIds.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
              <span>时间流里有 {sampleIds.length} 条示例笔记（#{SAMPLE_TAG}）</span>
              <button onClick={() => void clearSamples()} className="shrink-0 font-medium text-primary hover:underline">
                一键清除
              </button>
            </div>
          )}
          {grouped.map((g) => (
            <section key={g.label}>
              <div className="sticky top-[52px] z-10 -mx-1 bg-background/95 px-1 py-1.5 backdrop-blur md:top-0">
                <span className="text-xs font-medium text-muted-foreground">
                  {g.label}
                </span>
              </div>
              <div className="mt-1 space-y-3">
                {g.notes.map((n) => (
                  <NoteCard
                    key={n.id}
                    className={cn(
                      newIds.has(n.id) &&
                        "animate-in fade-in slide-in-from-top-2 duration-300",
                    )}
                    note={n}
                    onToggleTodo={(note) => void toggleTodo(note)}
                    onTagClick={setTag}
                    onEdit={(note, patch) => void handleEdit(note, patch)}
                    onDelete={(note) => void handleDelete(note)}
                    onToggleSensitive={(note) => void handleToggleSensitive(note)}
                    categoryFilterActive={category === n.category}
                    selectable={selectMode}
                    selected={selectedIds.has(n.id)}
                    onSelectToggle={toggleSelected}
                    threadTitle={n.thread_id ? threadTitles.get(n.thread_id) : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
          <div ref={sentinelRef} className="h-px" />
          {loadingMore && (
            <div className="flex justify-center py-3">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {/* 批量操作栏 */}
      {selectMode && (
        <div className="fixed inset-x-0 bottom-14 z-30 px-4 md:bottom-4 md:pl-56">
          <div className="mx-auto max-w-2xl rounded-xl border bg-card p-3 shadow-lg lg:max-w-3xl">
            {tagPanelOpen && (
              <div className="mb-2 space-y-2">
                {tagPanelMode === "remove" && !allMatching && selectedTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {selectedTags.map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant="outline"
                        disabled={batchBusy}
                        onClick={() => void batchRemoveTag(t)}
                      >
                        #{t}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    value={batchTagInput}
                    onChange={(e) => setBatchTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing)
                        void (tagPanelMode === "add" ? batchAddTag() : batchRemoveTag())
                    }}
                    placeholder={tagPanelMode === "add" ? "输入要加的标签名…" : "输入要移除的标签名…"}
                    className="h-8 flex-1"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    disabled={batchBusy || !batchTagInput.trim()}
                    onClick={() => void (tagPanelMode === "add" ? batchAddTag() : batchRemoveTag())}
                  >
                    {batchBusy ? <Loader2 className="animate-spin" /> : tagPanelMode === "add" ? "确定" : "移除"}
                  </Button>
                </div>
              </div>
            )}
            {catPanelOpen && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {CATEGORY_OPTIONS.map((c) => (
                  <Button
                    key={c.value}
                    size="sm"
                    variant="outline"
                    disabled={batchBusy}
                    onClick={() => void batchSetCategory(c.value)}
                  >
                    {c.label}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {batchBusy && batchProgress
                  ? `已处理 ${batchProgress.done}/${batchProgress.total}`
                  : allMatching
                    ? "已选全部匹配结果"
                    : `已选 ${selectedIds.size} 条`}
              </span>
              <button
                onClick={() => {
                  if (allMatching || selectedIds.size === notes.length) {
                    setAllMatching(false)
                    setSelectedIds(new Set())
                  } else {
                    setSelectedIds(new Set(notes.map((n) => n.id)))
                  }
                }}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {allMatching || selectedIds.size === notes.length ? "清空" : "全选"}
              </button>
              {!allMatching && selectedIds.size === notes.length && notes.length > 0 && (
                <button
                  onClick={() => setAllMatching(true)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  选中全部匹配结果
                </button>
              )}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(!allMatching && selectedIds.size === 0) || batchBusy}
                  onClick={() => {
                    setTagPanelOpen((x) => !(x && tagPanelMode === "add"))
                    setTagPanelMode("add")
                    setCatPanelOpen(false)
                  }}
                >
                  <Tag /> 打标签
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(!allMatching && selectedIds.size === 0) || batchBusy}
                  onClick={() => {
                    setTagPanelOpen((x) => !(x && tagPanelMode === "remove"))
                    setTagPanelMode("remove")
                    setCatPanelOpen(false)
                  }}
                >
                  <Eraser /> 移除标签
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(!allMatching && selectedIds.size === 0) || batchBusy}
                  onClick={() => {
                    setCatPanelOpen((x) => !x)
                    setTagPanelOpen(false)
                  }}
                >
                  <FolderInput /> 改分类
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={(!allMatching && selectedIds.size === 0) || batchBusy}
                  onClick={batchDelete}
                >
                  <Trash2 /> 删除
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === "all" ? "删除全部匹配碎念？" : `删除选中的 ${selectedIds.size} 条碎念？`}
        description="将移入「最近删除」，30 天内可恢复。"
        confirmLabel="删除"
        onConfirm={() => {
          const kind = confirmDelete
          setConfirmDelete(null)
          if (kind) runBatchDelete(kind)
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* 撤销提示 */}
      {toast && (
        <div className="fixed inset-x-0 bottom-28 z-40 flex justify-center px-4 md:bottom-16 md:pl-52">
          <div className="flex items-center gap-3 rounded-full border bg-popover px-4 py-2 text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2">
            <span>{toast.message}</span>
            {toast.undo && (
              <button onClick={toast.undo} className="font-medium text-primary hover:underline">
                {toast.undoLabel ?? "撤销"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Mobile FAB: scroll to quick input and focus it */}
      <button
        onClick={() => {
          quickInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
          quickInputRef.current?.querySelector("textarea")?.focus()
        }}
        aria-label="快速记录"
        className="fixed bottom-20 right-4 z-20 flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95 md:hidden"
      >
        <Plus className="size-6" />
      </button>
    </div>
  )
}
