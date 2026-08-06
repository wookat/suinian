import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { NoteCard } from "@/components/note-card"
import { getNotes, patchNote } from "@/lib/api"
import type { Note } from "@/lib/types"

export function TodosPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  }, [load])

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

  const open = notes.filter((n) => n.todo_done !== 1)
  const done = notes.filter((n) => n.todo_done === 1)

  if (loading)
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )

  return (
    <div className="space-y-5">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          未完成（{open.length}）
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">全部搞定，干得漂亮 ✦</p>
        ) : (
          open.map((n) => (
            <NoteCard key={n.id} note={n} onToggleTodo={(note) => void toggleTodo(note)} />
          ))
        )}
      </section>
      {done.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            已完成（{done.length}）
          </h2>
          {done.map((n) => (
            <NoteCard key={n.id} note={n} onToggleTodo={(note) => void toggleTodo(note)} />
          ))}
        </section>
      )}
    </div>
  )
}
