import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, Sparkles, X, Loader2, RefreshCw, Plus, PenLine, SearchX } from "lucide-react"
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
import { getNotes, getNote, patchNote, deleteNote, ApiError, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { Note } from "@/lib/types"

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

  async function handleEdit(note: Note, content: string) {
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, content } : n)))
    try {
      const fresh = await patchNote(note.id, { content })
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
                    onEdit={(note, content) => void handleEdit(note, content)}
                    onDelete={(note) => void handleDelete(note)}
                    onToggleSensitive={(note) => void handleToggleSensitive(note)}
                    categoryFilterActive={category === n.category}
                  />
                ))}
              </div>
            </section>
          ))}
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
