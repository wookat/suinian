import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  FolderInput,
} from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { QuickInput } from "@/components/quick-input"
import { DailyReview } from "@/components/daily-review"
import { NoteCard } from "@/components/note-card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { AskChat } from "@/components/ask-chat"
import { getNotes, getNote, patchNote, deleteNote, batchNotes, ApiError, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { Note, NoteCategory, NotePatch } from "@/lib/types"

const CATEGORY_OPTIONS: { value: NoteCategory; label: string }[] = [
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
]

const CATEGORY_TABS = [
  { value: "", label: "全部" },
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
] as const

const TOP_TAGS = 12
const MOBILE_TOP_TAGS = 6
const SEARCH_DEBOUNCE_MS = 300
const POLL_INTERVAL = 2000
const POLL_MAX = 15

type LoadError =
  | { kind: "auth" }
  | { kind: "network" }
  | { kind: "other"; message: string }

function dayLabel(iso: string): string {
  const d = new Date(iso)
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadError | null>(null)
  const [category, setCategory] = useState("")
  const [tag, setTag] = useState("")
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [askMode, setAskMode] = useState(false)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [mobileTagsExpanded, setMobileTagsExpanded] = useState(false)
  const [debouncing, setDebouncing] = useState(false)
  const debounceRef = useRef<number | null>(null)
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set())
  const abortRef = useRef<AbortController | null>(null)
  const pollersRef = useRef<Map<string, number>>(new Map())
  const quickInputRef = useRef<HTMLDivElement>(null)
  const settingsVersion = useSettingsVersion()

  // 多选批量操作
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchBusy, setBatchBusy] = useState(false)
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  const [catPanelOpen, setCatPanelOpen] = useState(false)
  const [batchTagInput, setBatchTagInput] = useState("")
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const pendingDeleteRef = useRef<{ ids: string[]; timer: number } | null>(null)

  const showToast = useCallback((message: string, undo?: () => void, ms = 6000) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ message, undo })
    toastTimerRef.current = window.setTimeout(() => setToast(null), ms)
  }, [])

  const flushPendingDelete = useCallback(() => {
    const pending = pendingDeleteRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingDeleteRef.current = null
    void batchNotes("delete", pending.ids).catch(() => {})
  }, [])

  useEffect(() => {
    const flush = () => flushPendingDelete()
    window.addEventListener("beforeunload", flush)
    return () => {
      window.removeEventListener("beforeunload", flush)
      flush()
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    }
  }, [flushPendingDelete])

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
    setTagPanelOpen(false)
    setCatPanelOpen(false)
  }

  function toggleSelected(note: Note) {
    setSelectedIds((ids) => {
      const next = new Set(ids)
      if (next.has(note.id)) next.delete(note.id)
      else next.add(note.id)
      return next
    })
  }

  function batchDelete() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`确定删除选中的 ${ids.length} 条碎念吗？`)) return
    flushPendingDelete()
    const removed = notes.filter((n) => selectedIds.has(n.id))
    setNotes((ns) => ns.filter((n) => !selectedIds.has(n.id)))
    exitSelectMode()
    const timer = window.setTimeout(() => {
      pendingDeleteRef.current = null
      void batchNotes("delete", ids).catch(() => void load())
    }, 6000)
    pendingDeleteRef.current = { ids, timer }
    showToast(`已删除 ${ids.length} 条`, () => {
      const pending = pendingDeleteRef.current
      if (pending) {
        window.clearTimeout(pending.timer)
        pendingDeleteRef.current = null
      }
      setNotes((ns) => {
        const restored = [...ns, ...removed]
        restored.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        return restored
      })
      setToast(null)
    })
  }

  async function batchAddTag() {
    const tag = batchTagInput.trim().replace(/^#/, "")
    const ids = [...selectedIds]
    if (!tag || ids.length === 0) return
    setBatchBusy(true)
    try {
      await batchNotes("add_tags", ids, { tags: [tag] })
      setNotes((ns) =>
        ns.map((n) => (selectedIds.has(n.id) && !n.tags.includes(tag) ? { ...n, tags: [...n.tags, tag] } : n)),
      )
      setBatchTagInput("")
      setTagPanelOpen(false)
      exitSelectMode()
      showToast(`已为 ${ids.length} 条加上 #${tag}`, () => {
        void batchNotes("remove_tags", ids, { tags: [tag] }).then(() => void load())
        setToast(null)
      })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
    } finally {
      setBatchBusy(false)
    }
  }

  async function batchSetCategory(cat: NoteCategory) {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setBatchBusy(true)
    const previous = notes
      .filter((n) => selectedIds.has(n.id))
      .map((n) => ({ id: n.id, category: n.category }))
    try {
      await batchNotes("set_category", ids, { category: cat })
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
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setNotes(res.notes)
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
  }, [category, tag, search])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  useEffect(() => {
    const applyHashTag = () => {
      const query = window.location.hash.split("?")[1]
      if (!query) return
      const t = new URLSearchParams(query).get("tag")
      if (t) {
        setTag(t)
        history.replaceState(null, "", `${window.location.pathname}#/`)
      }
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
    } catch {
      setNotes((ns) => ns.map((n) => (n.id === note.id ? note : n)))
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
    try {
      await deleteNote(note.id)
    } catch {
      setNotes(prev)
    }
  }

  const visibleTags = tagsExpanded ? allTags : allTags.slice(0, TOP_TAGS)
  const hiddenCount = allTags.length - TOP_TAGS

  return (
    <div className="space-y-4">
      <DailyReview onTagClick={setTag} />

      <div ref={quickInputRef}>
        <QuickInput onCreated={handleCreated} />
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
      </div>

      {askMode && <AskChat onTagClick={setTag} />}

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
          />
        ) : (
          <EmptyState
            icon={PenLine}
            title="还没有碎念"
            description="想法、待办、链接、资料，想到什么就丢进来，AI 会帮你自动分拣整理。"
            actionLabel="记下第一条"
            onAction={() => {
              quickInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
              quickInputRef.current?.querySelector("textarea")?.focus()
            }}
          />
        )
      ) : (
        <div className="space-y-4">
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
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* 批量操作栏 */}
      {selectMode && (
        <div className="fixed inset-x-0 bottom-14 z-30 px-4 md:bottom-4 md:pl-56">
          <div className="mx-auto max-w-2xl rounded-xl border bg-card p-3 shadow-lg lg:max-w-3xl">
            {tagPanelOpen && (
              <div className="mb-2 flex items-center gap-2">
                <Input
                  value={batchTagInput}
                  onChange={(e) => setBatchTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void batchAddTag()
                  }}
                  placeholder="输入标签名…"
                  className="h-8 flex-1"
                  autoFocus
                />
                <Button size="sm" disabled={batchBusy || !batchTagInput.trim()} onClick={() => void batchAddTag()}>
                  {batchBusy ? <Loader2 className="animate-spin" /> : "确定"}
                </Button>
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
              <span className="text-sm font-medium">已选 {selectedIds.size} 条</span>
              <button
                onClick={() =>
                  setSelectedIds(
                    selectedIds.size === notes.length
                      ? new Set()
                      : new Set(notes.map((n) => n.id)),
                  )
                }
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {selectedIds.size === notes.length ? "清空" : "全选"}
              </button>
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0 || batchBusy}
                  onClick={() => {
                    setTagPanelOpen((x) => !x)
                    setCatPanelOpen(false)
                  }}
                >
                  <Tag /> 打标签
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.size === 0 || batchBusy}
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
                  disabled={selectedIds.size === 0 || batchBusy}
                  onClick={batchDelete}
                >
                  <Trash2 /> 删除
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 撤销提示 */}
      {toast && (
        <div className="fixed inset-x-0 bottom-28 z-40 flex justify-center px-4 md:bottom-16 md:pl-52">
          <div className="flex items-center gap-3 rounded-full border bg-popover px-4 py-2 text-sm shadow-lg animate-in fade-in slide-in-from-bottom-2">
            <span>{toast.message}</span>
            {toast.undo && (
              <button onClick={toast.undo} className="font-medium text-primary hover:underline">
                撤销
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
