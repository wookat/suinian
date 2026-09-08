import { useCallback, useEffect, useMemo, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { CheckCircle2, ChevronDown, ListTodo } from "lucide-react"
import { NoteCard } from "@/components/note-card"
import type { EditResult } from "@/components/note-card"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { EmptyState } from "@/components/empty-state"
import { cn, parseDue, dueHasTime } from "@/lib/utils"
import { getNotes, getNote, patchNote, deleteNote, ApiError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import type { Note, NotePatch } from "@/lib/types"

type DueGroup = "overdue" | "today" | "week" | "later" | "none"

const GROUP_META: Record<DueGroup, string> = {
  overdue: "已过期",
  today: "今天",
  week: "本周",
  later: "更晚",
  none: "无期限",
}

const GROUP_ORDER: DueGroup[] = ["overdue", "today", "week", "later", "none"]

const GROUP_DOT: Record<DueGroup, string> = {
  overdue: "bg-destructive",
  today: "bg-warning",
  week: "bg-primary",
  later: "bg-info",
  none: "bg-muted-foreground/50",
}

function dueGroup(due: string | null): DueGroup {
  if (!due) return "none"
  const d = parseDue(due)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const dayDiff = Math.round(
    (startOfDay(d).getTime() - startOfDay(now).getTime()) / 86400_000,
  )
  if (dayDiff < 0 && (!dueHasTime(due) || d.getTime() < now.getTime())) return "overdue"
  if (dayDiff <= 0) return "today"
  if (dayDiff <= 7) return "week"
  return "later"
}

export function TodosPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [sensitivePendingIds, setSensitivePendingIds] = useState<Set<string>>(() => new Set())
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getNotes({ category: "todo" })
      setNotes(res.notes)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

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

  // R206 P2-2：同一笔记在途去重 + pending 反馈（与 timeline 同口径）
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

  async function handleEdit(note: Note, patch: NotePatch): Promise<EditResult> {
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, ...patch } : n)))
    try {
      const fresh = await patchNote(note.id, patch, note.updated_at)
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
      setError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // refresh to the latest copy and hand it back to the card, which keeps
        // the user's typed text for merging
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
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}，请重试`)
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

  const openGroups = useMemo(() => {
    const open = notes
      .filter((n) => n.todo_done !== 1)
      .sort((a, b) => {
        if (a.todo_due === null && b.todo_due === null) return 0
        if (a.todo_due === null) return 1
        if (b.todo_due === null) return -1
        return a.todo_due < b.todo_due ? -1 : 1
      })
    const map = new Map<DueGroup, Note[]>()
    for (const n of open) {
      const g = dueGroup(n.todo_due)
      const arr = map.get(g) ?? []
      arr.push(n)
      map.set(g, arr)
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      group: g,
      notes: map.get(g)!,
    }))
  }, [notes])

  const done = notes.filter((n) => n.todo_done === 1)
  const openCount = notes.length - done.length

  if (loading) return <NoteListSkeleton />

  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {openCount > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{openCount}</span> 项待办
          {done.length > 0 && (
            <>
              ，已完成 <span className="tabular-nums">{done.length}</span> 项
            </>
          )}
        </p>
      )}
      {notes.length === 0 && !error ? (
        <EmptyState
          icon={ListTodo}
          title="还没有待办"
          description="在碎念里写下要做的事，AI 会自动识别为待办并帮你提取期限。"
          actionLabel="去首页记一条"
          onAction={() => {
            window.location.hash = "#/"
          }}
        />
      ) : openCount === 0 && !error ? (
        <EmptyState
          icon={CheckCircle2}
          title="全部搞定，干得漂亮 ✦"
          description="所有待办都已完成，去首页记点新想法吧。"
        />
      ) : (
        openGroups.map(({ group, notes: gnotes }) => (
          <section key={group} className="space-y-3" aria-label={GROUP_META[group]}>
            <h2 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <span aria-hidden className={cn("size-2 rounded-full", GROUP_DOT[group])} />
              {GROUP_META[group]}
              <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 tabular-nums">
                {gnotes.length}
              </Badge>
            </h2>
            <AnimatePresence initial={false}>
              {gnotes.map((n) => (
                <m.div
                  key={n.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                >
                  <NoteCard
                    note={n}
                    onToggleTodo={(note) => void toggleTodo(note)}
                    onEdit={handleEdit}
                    onDelete={(note) => void handleDelete(note)}
                    onToggleSensitive={(note) => void handleToggleSensitive(note)}
                    sensitivePending={sensitivePendingIds.has(n.id)}
                  />
                </m.div>
              ))}
            </AnimatePresence>
          </section>
        ))
      )}
      {done.length > 0 && (
        <Collapsible open={doneExpanded} onOpenChange={setDoneExpanded} asChild>
          <section className="space-y-3">
            <CollapsibleTrigger className="flex min-h-9 items-center gap-2 rounded-md px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-200",
                  !doneExpanded && "-rotate-90",
                )}
              />
              已完成
              <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 tabular-nums">
                {done.length}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2">
              {done.map((n) => (
                <NoteCard
                  key={n.id}
                  className="opacity-80 transition-opacity hover:opacity-100"
                  note={n}
                  onToggleTodo={(note) => void toggleTodo(note)}
                  onEdit={handleEdit}
                  onDelete={(note) => void handleDelete(note)}
                  onToggleSensitive={(note) => void handleToggleSensitive(note)}
                  sensitivePending={sensitivePendingIds.has(n.id)}
                />
              ))}
            </CollapsibleContent>
          </section>
        </Collapsible>
      )}
    </div>
  )
}
