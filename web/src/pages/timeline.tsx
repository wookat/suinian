import { useCallback, useEffect, useMemo, useState } from "react"
import { Search, Sparkles, X, Loader2 } from "lucide-react"
import { QuickInput } from "@/components/quick-input"
import { NoteCard } from "@/components/note-card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { getNotes, patchNote, ask } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { AskResponse, Note } from "@/lib/types"

const CATEGORY_TABS = [
  { value: "", label: "全部" },
  { value: "idea", label: "想法" },
  { value: "todo", label: "待办" },
  { value: "collect", label: "收藏" },
  { value: "data", label: "资料" },
] as const

export function TimelinePage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState("")
  const [tag, setTag] = useState("")
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState("")
  const [askMode, setAskMode] = useState(false)
  const [asking, setAsking] = useState(false)
  const [askResult, setAskResult] = useState<AskResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getNotes({
        category: category || undefined,
        tag: tag || undefined,
        q: search || undefined,
      })
      setNotes(res.notes)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [category, tag, search])

  useEffect(() => {
    void load()
  }, [load])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const n of notes) for (const t of n.tags) set.add(t)
    return [...set].sort()
  }, [notes])

  async function handleSubmitSearch() {
    if (askMode) {
      const q = query.trim()
      if (!q || asking) return
      setAsking(true)
      setAskResult(null)
      try {
        setAskResult(await ask(q))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setAsking(false)
      }
    } else {
      setSearch(query.trim())
    }
  }

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

  return (
    <div className="space-y-4">
      <QuickInput onCreated={() => void load()} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (!askMode && e.target.value === "") setSearch("")
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void handleSubmitSearch()
            }}
            placeholder={askMode ? "问问你的笔记，例如：我之前想过的那个点子…" : "搜索笔记…"}
            className="pl-8"
          />
        </div>
        <Button
          variant={askMode ? "default" : "outline"}
          size="sm"
          className="h-9"
          onClick={() => {
            setAskMode((m) => !m)
            setAskResult(null)
          }}
        >
          <Sparkles />
          问答
        </Button>
      </div>

      {askMode && (askResult || asking) && (
        <Card className="border-primary/30 bg-accent/40 p-4">
          {asking ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 正在思考…
            </div>
          ) : (
            askResult && (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {askResult.answer}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    onClick={() => setAskResult(null)}
                    aria-label="关闭回答"
                  >
                    <X />
                  </Button>
                </div>
                {askResult.notes.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      引用笔记（{askResult.notes.length}）
                    </p>
                    {askResult.notes.map((n) => (
                      <NoteCard key={n.id} note={n} />
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </Card>
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
        <div className="flex flex-wrap gap-1.5">
          {tag && (
            <Badge
              className="cursor-pointer"
              onClick={() => setTag("")}
            >
              #{tag} <X className="ml-0.5 size-3" />
            </Badge>
          )}
          {allTags
            .filter((t) => t !== tag)
            .map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => setTag(t)}
              >
                #{t}
              </Badge>
            ))}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {loading ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : notes.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          还没有笔记，在上面记一条吧
        </p>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              onToggleTodo={(note) => void toggleTodo(note)}
              onTagClick={setTag}
            />
          ))}
        </div>
      )}
    </div>
  )
}
