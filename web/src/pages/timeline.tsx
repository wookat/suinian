import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { toast as sonnerToast } from "@/lib/toast"
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
  ChevronDown,
} from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { QuickInput } from "@/components/quick-input"
import { DailyReview } from "@/components/daily-review"
import { DueTodosBanner } from "@/components/due-todos"
import { NoteCard } from "@/components/note-card"
import type { EditResult } from "@/components/note-card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getNotes, getNote, createNote, patchNote, deleteNote, restoreNotes, batchNotes, batchNotesByFilter, restoreCategories, getThreads, getStats, ApiError, NetworkError } from "@/lib/api"
import type { BatchFilter } from "@/lib/api"
import { useRetryOnReconnect } from "@/lib/use-retry-on-reconnect"
import { notifyNotesDeleted, notifyReviewRefresh } from "@/lib/review-bus"
import { loadSettings, saveSettings, useSettingsVersion } from "@/lib/settings"
import { PENDING_UNDO_KEY } from "@/lib/pending-undo"
import { ChunkBoundary } from "@/components/chunk-boundary"
import { lazyRetry } from "@/lib/lazy-retry"
import { FirstRunTour } from "@/components/first-run-tour"
import { cn, parseServerTime } from "@/lib/utils"
import type { Note, NoteCategory, NotePatch, PrevCategory } from "@/lib/types"

// ask mode is opt-in: keep its chat UI out of the first-paint bundle
const AskChat = lazyRetry(
  () => import("@/components/ask-chat"),
  (m) => m.AskChat,
)

const CATEGORY_OPTIONS: { value: NoteCategory; label: string }[] = [
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "资金往来" },
]

const CATEGORY_TABS = [
  { value: "", label: "全部" },
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "资金往来" },
] as const

const SAMPLE_TAG = "示例"
// 种子示例笔记按 id 记在本机，不再靠 #示例 标签识别：AI 分拣可能给真实
// 笔记也打上同名标签，「一键清除」不能误删用户数据（R166 P2-2）
const SAMPLE_IDS_KEY = "suinian.sample-note-ids"

function loadSampleIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAMPLE_IDS_KEY) ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

function saveSampleIds(ids: string[]) {
  if (ids.length > 0) localStorage.setItem(SAMPLE_IDS_KEY, JSON.stringify(ids))
  else localStorage.removeItem(SAMPLE_IDS_KEY)
}
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
// （删除走服务端软删进「最近删除」，30 天后真删；标签操作记录实际变更的 ids 做逆操作；
// 改分类用服务端回传的原分类快照 prev 做逆向批量恢复）
const PENDING_UNDO_TTL_MS = 5 * 60 * 1000

type PendingUndo = {
  kind: "restore" | "add_tags" | "remove_tags" | "set_category"
  ids: string[]
  tag?: string
  prev?: PrevCategory[]
  message: string
  expires: number
}

type LoadError =
  | { kind: "auth"; notLoggedIn: boolean }
  | { kind: "network"; message: string }
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

// R206 P3-1：批量导入后分拣积压进度横幅——已加载列表里出现成批待分拣的
// 导入笔记时，用既有 /api/stats 的 pending 计数展示全库剩余量并定时刷新，
// 迁移大库用户首小时能看到消化进度而不是满屏转圈无反馈
const BACKLOG_BANNER_MIN = 5
const BACKLOG_POLL_MS = 60_000
/** 顶部异步横幅最多等这么久，超时就直接显示下方内容 */
const TOP_BANNERS_SETTLE_MS = 1500

function TriageBacklogBanner({ notes }: { notes: Note[] }) {
  const [backlog, setBacklog] = useState<number | null>(null)
  const loadedPending = notes.filter((n) => n.category === null && n.meta?.imported_at != null).length
  const active = loadedPending >= BACKLOG_BANNER_MIN
  useEffect(() => {
    if (!active) {
      setBacklog(null)
      return
    }
    let stopped = false
    const tick = async () => {
      try {
        const s = await getStats(1)
        if (!stopped) setBacklog(s.categories.find((c) => c.category === "pending")?.count ?? 0)
      } catch {
        // 锦上添花的进度提示：拿不到计数就不展示，不报错
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), BACKLOG_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(id)
    }
  }, [active])
  if (!active || backlog === null || backlog === 0) return null
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 shrink-0 animate-spin" />
      导入的笔记正在后台排队分拣：还剩 {backlog.toLocaleString()} 条待分拣，自动完成无需等待，期间搜索与时间流不受影响
    </div>
  )
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
  // 搜索空态「用 AI 问问看」：只预填不自发，由用户确认后再消耗 AI 调用
  const [askInputPrefill, setAskInputPrefill] = useState<string | null>(null)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [mobileTagsExpanded, setMobileTagsExpanded] = useState(false)
  const [debouncing, setDebouncing] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set())
  const [sensitivePendingIds, setSensitivePendingIds] = useState<Set<string>>(() => new Set())
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
  // 驻留撤销条：不随 toast 自动消失，撤销/关闭/过期才走
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null)
  const pendingUndoTimerRef = useRef<number | null>(null)

  // 轻提示走 sonner（底部居中、可带撤销动作），同一时刻只保留一条
  const showToast = useCallback((message: string, undo?: () => void, ms = 6000, undoLabel?: string) => {
    sonnerToast.dismiss()
    sonnerToast(message, {
      duration: ms,
      action: undo ? { label: undoLabel ?? "撤销", onClick: undo } : undefined,
    })
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
        } else if (p.kind === "set_category") {
          const res = await restoreCategories(p.prev ?? [])
          showToast(`已撤销：恢复 ${res.affected} 条的原分类`)
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
    type Saved = { kind?: unknown; ids?: unknown; tag?: unknown; prev?: unknown; message?: unknown; expires?: unknown }
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
      saved.kind === "add_tags" || saved.kind === "remove_tags" || saved.kind === "set_category"
        ? saved.kind
        : "restore"
    const tag = typeof saved.tag === "string" ? saved.tag : undefined
    const prev = Array.isArray(saved.prev)
      ? (saved.prev as unknown[]).filter(
          (e): e is PrevCategory =>
            typeof e === "object" && e !== null && typeof (e as PrevCategory).id === "string",
        )
      : undefined
    if (
      ids.length === 0 ||
      expires <= Date.now() ||
      (kind === "add_tags" || kind === "remove_tags" ? !tag : false) ||
      (kind === "set_category" && (!prev || prev.length === 0))
    ) {
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
      prev,
      message: typeof saved.message === "string" ? saved.message : `已删除 ${ids.length} 条`,
      expires,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
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
        // 时间快照边界：续删循环期间（微信/API）异步新写入且命中过滤条件的
        // 笔记不能被顺手删掉——用户确认删除时从未见过它们
        const snapshotTo = new Date().toISOString().slice(0, 19).replace("T", " ")
        const base0 = currentFilter()
        // 用户已有的 to（date-only 时服务端按当天 23:59:59 解释）与快照取更早者
        const userTo = base0.to ? (base0.to.length === 10 ? `${base0.to} 23:59:59` : base0.to) : null
        const filter: BatchFilter = { ...base0, to: userTo && userTo <= snapshotTo ? userTo : snapshotTo }
        const allIds: string[] = []
        let base = 0
        let extraRemaining = 0
        for (;;) {
          const res = await batchNotesByFilter("delete", filter, undefined, (done, total) =>
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
        const message =
          res.remaining > 0
            ? `已将前 ${res.affected} 条改为「${label}」，剩余 ${res.remaining} 条请再次执行`
            : `已将全部匹配的 ${res.affected} 条改为「${label}」`
        // 与其余批量操作同一驻留撤销条：用服务端回传的原分类快照逆向恢复
        if (res.prev && res.prev.length > 0)
          showPendingUndo({ kind: "set_category", ids: res.ids, prev: res.prev, message })
        else showToast(message)
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
      const res = await batchNotes("set_category", ids, { category: cat }, (done, total) => setBatchProgress({ done, total }))
      setNotes((ns) => ns.map((n) => (selectedIds.has(n.id) ? { ...n, category: cat } : n)))
      setCatPanelOpen(false)
      exitSelectMode()
      const label = CATEGORY_OPTIONS.find((c) => c.value === cat)?.label ?? cat
      if (res.prev && res.prev.length > 0) {
        showPendingUndo({ kind: "set_category", ids: res.ids, prev: res.prev, message: `已将 ${res.affected} 条改为「${label}」` })
      } else
        showToast(`已将 ${ids.length} 条改为「${label}」`, () => {
          void Promise.allSettled(
            previous.filter((p) => p.category).map((p) => patchNote(p.id, { category: p.category! })),
          ).then(() => void load())
          sonnerToast.dismiss()
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
      const ids = loadSampleIds()
      for (const content of SAMPLE_NOTES) {
        const note = await createNote({ source: "web", raw_type: "text", content, tags: [SAMPLE_TAG] })
        ids.push(note.id)
        handleCreated(note)
      }
      saveSampleIds(ids)
      setSeededIds(ids)
      showToast(`已丢入 ${SAMPLE_NOTES.length} 条示例，AI 正在自动分拣…`)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setSeeding(false)
    }
  }

  const [seededIds, setSeededIds] = useState<string[]>(loadSampleIds)
  const sampleIds = useMemo(
    () => notes.filter((n) => seededIds.includes(n.id)).map((n) => n.id),
    [notes, seededIds],
  )

  async function clearSamples() {
    const ids = seededIds
    if (ids.length === 0) return
    try {
      await batchNotes("delete", ids)
      setNotes((ns) => ns.filter((n) => !ids.includes(n.id)))
      notifyNotesDeleted(ids)
      saveSampleIds([])
      setSeededIds([])
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
        setError({ kind: "auth", notLoggedIn: !loadSettings().apiToken })
      else if (e instanceof NetworkError) setError({ kind: "network", message: e.message })
      else setError({ kind: "other", message: e instanceof Error ? e.message : String(e) })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [category, tag, search, sourceFilter, fromDate, toDate])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  useRetryOnReconnect(!loading && error?.kind === "network", load)

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
      // 命令面板入口（⌘K）：q=搜索 / ask=预填提问 / compose=聚焦速记框
      const q = params.get("q")
      const ask = params.get("ask")
      const compose = params.get("compose")
      if (t) setTag(t)
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        setFromDate(d)
        setToDate(d)
        setFiltersOpen(true)
      }
      if (q) {
        setSearchInput(q)
        setSearch(q)
      }
      if (ask) {
        setAskInputPrefill(ask)
        setAskMode(true)
      }
      if (compose) {
        window.setTimeout(() => {
          quickInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
          quickInputRef.current?.querySelector("textarea")?.focus()
        }, 50)
      }
      if (t || d || q || ask || compose) history.replaceState(null, "", `${window.location.pathname}#/`)
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
      setNotes((ns) => (ns.some((n) => n.id === note.id) ? ns : [note, ...ns]))
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
    // 敏感笔记的派生标签不进公开标签面（与 /api/tags、标签管理口径一致）
    for (const n of notes) {
      if (n.is_sensitive === 1) continue
      for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1)
    }
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

  async function handleEdit(note: Note, patch: NotePatch): Promise<EditResult> {
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, ...patch } : n)))
    try {
      const fresh = await patchNote(note.id, patch, note.updated_at)
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // another device edited this note first: refresh to the latest copy and
        // hand it back to the card, which keeps the user's typed text for merging
        let latest: Note | null = null
        try {
          latest = await getNote(note.id)
        } catch {
          // fall back to the pre-edit copy below
        }
        setNotes((ns) => ns.map((n) => (n.id === note.id ? (latest ?? note) : n)))
        return { conflict: latest ?? note }
      }
      setNotes((ns) => ns.map((n) => (n.id === note.id ? note : n)))
      showToast(
        `保存失败：${e instanceof Error ? e.message : String(e)}`,
        () => {
          sonnerToast.dismiss()
          void handleEdit(note, patch)
        },
        10000,
        "重试",
      )
    }
  }

  // R206 P2-2：敏感标记切换加 pending 态——在途请求去重（同一笔记只允许一个
  // PATCH），慢网下菜单项禁用+徽标转圈，终态与最后一次意图一致
  async function handleToggleSensitive(note: Note) {
    if (sensitivePendingIds.has(note.id)) return
    const next = note.is_sensitive === 1 ? 0 : 1
    setSensitivePendingIds((ids) => new Set(ids).add(note.id))
    try {
      const fresh = await patchNote(note.id, { is_sensitive: next })
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
    } catch {
      // keep original note on failure
    } finally {
      setSensitivePendingIds((ids) => {
        const s = new Set(ids)
        s.delete(note.id)
        return s
      })
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

  // 顶部异步横幅（今日回顾 / 到期待办）后到会把输入框与列表整体下推：在它们就位（或超时）前
  // 下方内容先不绘制（visibility:hidden 保留占位），避免首屏 CLS。
  const [reviewSettled, setReviewSettled] = useState(false)
  const [dueSettled, setDueSettled] = useState(false)
  const [topTimedOut, setTopTimedOut] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setTopTimedOut(true), TOP_BANNERS_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [])
  const topSettled = topTimedOut || (reviewSettled && dueSettled)

  return (
    <div className="space-y-4">
      {showTour && <FirstRunTour onDone={() => setShowTour(false)} />}

      {/* 驻留撤销条：批量操作后顶部常驻（5 分钟），慢返回/刷新后仍可撤销 */}
      {pendingUndo && (
        <div className="sticky top-2 z-30">
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-popover/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur animate-in fade-in slide-in-from-top-2">
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

      <DueTodosBanner onSettled={() => setDueSettled(true)} />

      <TriageBacklogBanner notes={notes} />

      <DailyReview onTagClick={setTag} onSettled={() => setReviewSettled(true)} />

      <div className={cn("space-y-4", !topSettled && "invisible")}>
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
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
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
            aria-label="搜索笔记"
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
        <m.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/60 p-2.5 text-sm"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 w-[9.5rem] justify-between font-normal" aria-label="来源筛选">
                {SOURCE_OPTIONS.find((o) => o.value === sourceFilter)?.label ?? SOURCE_OPTIONS[0].label}
                <ChevronDown className="text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[9.5rem]">
              <DropdownMenuRadioGroup
                value={sourceFilter || "__all"}
                onValueChange={(v) => setSourceFilter(v === "__all" ? "" : v)}
              >
                {SOURCE_OPTIONS.map((o) => (
                  <DropdownMenuRadioItem key={o.value} value={o.value || "__all"}>
                    {o.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 rounded-lg border border-input bg-card px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
              aria-label="开始日期"
            />
            <span className="text-muted-foreground">→</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 rounded-lg border border-input bg-card px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
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
        </m.div>
      )}

      {askMode && (
        <ChunkBoundary
          fallback={({ chunk }) => (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4 text-sm" role="alert">
              <span className="text-muted-foreground">
                {chunk ? "问答面板的代码没能下载完成（多半是网络中断），联网后重新加载即可" : "问答面板出错了"}
              </span>
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                重新加载
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAskMode(false)}>
                关闭
              </Button>
            </div>
          )}
        >
          <Suspense
            // 问答面板是懒加载分包：慢网/请求在途时 fallback 为空会让点击「问答」
            // 毫无反馈（R228 P3-5），先给一个可见的加载占位
            fallback={
              <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" role="status">
                问答面板加载中…
              </div>
            }
          >
            <AskChat
              onTagClick={setTag}
              initialQuestion={askPrefill}
              onInitialQuestionConsumed={() => setAskPrefill(null)}
              initialInput={askInputPrefill}
              onInitialInputConsumed={() => setAskInputPrefill(null)}
              onClose={() => setAskMode(false)}
            />
          </Suspense>
        </ChunkBoundary>
      )}

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        {CATEGORY_TABS.map((t) => {
          const isActive = category === t.value
          return (
            <button
              key={t.value}
              onClick={() => setCategory(t.value)}
              aria-pressed={isActive}
              className={cn(
                "relative shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                isActive ? "text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {isActive && (
                <m.span
                  layoutId="category-pill"
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-primary shadow-sm"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          )
        })}
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
              className="inline-flex min-h-6 items-center py-1 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
            >
              {mobileTagsExpanded
                ? "收起"
                : `展开（${visibleTags.filter((t) => t !== tag).length - MOBILE_TOP_TAGS}）`}
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              onClick={() => setTagsExpanded((x) => !x)}
              className="hidden min-h-6 items-center py-1 text-xs font-medium text-muted-foreground hover:text-foreground md:inline-flex"
            >
              {tagsExpanded ? "收起" : `更多（${hiddenCount}）`}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <NoteListSkeleton />
      ) : error ? (
        <Card className="flex flex-col items-center gap-3 border-dashed p-8 text-center">
          {error.kind === "auth" && error.notLoggedIn ? (
            <>
              <p className="text-sm text-muted-foreground">
                尚未登录，登录后才能看到你自己的碎念。
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    window.location.hash = "#/auth"
                  }}
                >
                  登录 / 注册
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    saveSettings({ ...loadSettings(), useMock: true })
                  }}
                >
                  先看演示
                </Button>
              </div>
            </>
          ) : error.kind === "auth" ? (
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
              <p className="text-sm text-muted-foreground">{error.message}</p>
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
            description={`换个关键词、标签或分类试试，或清除筛选条件查看全部碎念。删过的内容不在这里，可到「最近删除」找找。${search ? "敏感笔记正文已加密存储、不参与搜索；其标签命中时会以遮罩形式出现在结果里，点击可解锁查看。" : ""}`}
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
                    setAskInputPrefill(search)
                    window.scrollTo({ top: 0, behavior: "smooth" })
                  }
                : undefined
            }
            tertiaryActionLabel="到最近删除找找"
            onTertiaryAction={() => {
              window.location.hash = "#/trash"
            }}
          />
        ) : (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center"
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(60%_80%_at_50%_0%,color-mix(in_oklch,var(--color-primary)_14%,transparent),transparent)]"
            />
            <span className="relative flex size-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
              <PenLine className="size-6 text-primary" strokeWidth={1.75} />
            </span>
            <h2 className="relative text-base font-semibold tracking-tight">还没有碎念</h2>
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
          </m.div>
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
              {/* 不做 -mx-1 负边距出血：rem 随字号档缩放，特大档会溢出主栏右缘（R218 P3-1） */}
              <div className="sticky top-[52px] z-10 flex items-center gap-2 bg-background/90 py-1.5 backdrop-blur md:top-0">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</span>
                <span aria-hidden className="h-px flex-1 bg-border" />
              </div>
              <div className="mt-1 space-y-3">
                <AnimatePresence initial={false}>
                {g.notes.map((n) => (
                  <m.div
                    key={n.id}
                    initial={newIds.has(n.id) ? { opacity: 0, y: -10, scale: 0.98 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                    transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                  >
                  <NoteCard
                    note={n}
                    onToggleTodo={(note) => void toggleTodo(note)}
                    onTagClick={setTag}
                    onEdit={handleEdit}
                    onDelete={(note) => void handleDelete(note)}
                    onToggleSensitive={(note) => void handleToggleSensitive(note)}
                    sensitivePending={sensitivePendingIds.has(n.id)}
                    categoryFilterActive={category === n.category}
                    selectable={selectMode}
                    selected={selectedIds.has(n.id)}
                    onSelectToggle={toggleSelected}
                    threadTitle={n.thread_id ? threadTitles.get(n.thread_id) : undefined}
                    onAskQuestion={(q) => {
                      setAskMode(true)
                      setAskInputPrefill(q)
                      window.scrollTo({ top: 0, behavior: "smooth" })
                    }}
                  />
                  </m.div>
                ))}
                </AnimatePresence>
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
        <div className="fixed inset-x-0 bottom-16 z-30 px-4 md:bottom-4 md:pl-56">
          <div className="mx-auto max-w-2xl rounded-2xl border bg-card/95 p-3 shadow-xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 lg:max-w-3xl">
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

      {/* Mobile FAB: scroll to quick input and focus it.
          问答模式下隐藏：面板内没有快速记录入口，悬浮钮只会遮挡引用卡片
          右下角（audit-r247 F-5）。 */}
      {!askMode && (
        <button
          onClick={() => {
            quickInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
            quickInputRef.current?.querySelector("textarea")?.focus()
          }}
          aria-label="快速记录"
          className="fixed bottom-20 right-4 z-20 flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-transform active:scale-95 md:hidden"
        >
          <Plus className="size-6" />
        </button>
      )}
      </div>
    </div>
  )
}
