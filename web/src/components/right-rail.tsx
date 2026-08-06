import { useEffect, useMemo, useState } from "react"
import { Hash, BarChart3 } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getNotes } from "@/lib/api"
import type { Note } from "@/lib/types"

const MAX_RAIL_TAGS = 20

export function RightRail() {
  const [notes, setNotes] = useState<Note[] | null>(null)

  useEffect(() => {
    let cancelled = false
    getNotes({ limit: 100 })
      .then((res) => {
        if (!cancelled) setNotes(res.notes)
      })
      .catch(() => {
        if (!cancelled) setNotes([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const tags = useMemo(() => {
    const count = new Map<string, number>()
    for (const n of notes ?? [])
      for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_RAIL_TAGS)
  }, [notes])

  const stats = useMemo(() => {
    if (!notes) return null
    const days = new Set(notes.map((n) => n.created_at.slice(0, 10)))
    return { total: notes.length, days: days.size }
  }, [notes])

  if (!notes || notes.length === 0) return null

  return (
    <div className="space-y-4">
      {stats && (
        <Card className="p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <BarChart3 className="size-4 text-muted-foreground" /> 记录统计
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-secondary p-3 text-center">
              <p className="text-lg font-semibold tabular-nums">{stats.days}</p>
              <p className="text-xs text-muted-foreground">记录天数</p>
            </div>
            <div className="rounded-lg bg-secondary p-3 text-center">
              <p className="text-lg font-semibold tabular-nums">{stats.total}</p>
              <p className="text-xs text-muted-foreground">总条数</p>
            </div>
          </div>
        </Card>
      )}
      {tags.length > 0 && (
        <Card className="p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Hash className="size-4 text-muted-foreground" /> 标签云
          </h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map(([t, c]) => (
              <Badge
                key={t}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => {
                  window.location.hash = `#/?tag=${encodeURIComponent(t)}`
                }}
              >
                #{t}
                <span className="ml-1 text-muted-foreground">{c}</span>
              </Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
