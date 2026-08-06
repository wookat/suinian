import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCircle2, ChevronDown, ListTodo } from "lucide-react"
import { NoteCard } from "@/components/note-card"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { cn, parseDue, dueHasTime } from "@/lib/utils"
import { getNotes, patchNote, deleteNote } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import type { Note } from "@/lib/types"

type DueGroup = "overdue" | "today" | "week" | "later" | "none"

const GROUP_META: Record<DueGroup, string> = {
  overdue: "已过期",
  today: "今天",
  week: "本周",
  later: "更晚",
  none: "无期限",
}

const GROUP_ORDER: DueGroup[] = ["overdue", "today", "week", "later", "none"]

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

  async function handleEdit(note: Note, content: string) {
    setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, content } : n)))
    try {
      const fresh = await patchNote(note.id, { content })
      setNotes((ns) => ns.map((n) => (n.id === note.id ? fresh : n)))
    } catch {
      setNotes((ns) => ns.map((n) => (n.id === note.id ? note : n)))
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
    <div className="space-y-5">
      {error && <p className="text-sm text-destructive">{error}</p>}
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
          <section key={group} className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {GROUP_META[group]}（{gnotes.length}）
            </h2>
            {gnotes.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                onToggleTodo={(note) => void toggleTodo(note)}
                onEdit={(note, content) => void handleEdit(note, content)}
                onDelete={(note) => void handleDelete(note)}
              />
            ))}
          </section>
        ))
      )}
      {done.length > 0 && (
        <section className="space-y-3">
          <button
            onClick={() => setDoneExpanded((x) => !x)}
            className="flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-4 transition-transform duration-200",
                !doneExpanded && "-rotate-90",
              )}
            />
            已完成（{done.length}）
          </button>
          {doneExpanded &&
            done.map((n) => (
              <NoteCard
                key={n.id}
                className="animate-in fade-in slide-in-from-top-2 duration-200"
                note={n}
                onToggleTodo={(note) => void toggleTodo(note)}
                onEdit={(note, content) => void handleEdit(note, content)}
                onDelete={(note) => void handleDelete(note)}
              />
            ))}
        </section>
      )}
    </div>
  )
}
