import { useCallback, useEffect, useState } from "react"
import { GitBranch, ChevronLeft, RefreshCw, Network, ArrowRight } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NoteCard } from "@/components/note-card"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { getThreads, getThread } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { formatTime } from "@/lib/utils"
import type { Thread, ThreadDetail } from "@/lib/types"

function timelineDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
  return d.getFullYear() === new Date().getFullYear()
    ? date
    : `${d.getFullYear()}年${date}`
}

export function ThreadsPage() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getThreads()
      setThreads(res.threads)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  useEffect(() => {
    const applyHashId = () => {
      const query = window.location.hash.split("?")[1]
      if (!query) return
      const id = new URLSearchParams(query).get("id")
      if (id) {
        setSelected(id)
        history.replaceState(null, "", `${window.location.pathname}#/threads`)
      }
    }
    applyHashId()
    window.addEventListener("hashchange", applyHashId)
    return () => window.removeEventListener("hashchange", applyHashId)
  }, [])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    getThread(selected)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch((e) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  if (selected) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setSelected(null)}>
          <ChevronLeft className="size-4" /> 返回线索列表
        </Button>
        {detailLoading ? (
          <NoteListSkeleton />
        ) : detailError ? (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-sm text-destructive">{detailError}</p>
            <Button size="sm" variant="outline" onClick={() => setSelected(selected)}>
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          </Card>
        ) : (
          detail && (
            <>
              <Card className="p-4">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-4 text-muted-foreground" />
                  <h2 className="text-base font-semibold">{detail.title}</h2>
                </div>
                {detail.summary && (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {detail.summary}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {detail.note_count} 条碎片 · 更新于 {formatTime(detail.updated_at)}
                </p>
              </Card>
              {detail.graph && detail.graph.entities.length > 0 && (
                <Card className="p-4">
                  <div className="flex items-center gap-2">
                    <Network className="size-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold">实体与关系脉络</h3>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {detail.graph.entities.map((e) => (
                      <span
                        key={e.id}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
                      >
                        {e.name}
                        {e.note_count > 1 && (
                          <span className="text-[10px] text-muted-foreground">×{e.note_count}</span>
                        )}
                      </span>
                    ))}
                  </div>
                  {detail.graph.relations.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t pt-3">
                      {detail.graph.relations.map((r, i) => (
                        <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{r.src}</span>
                          <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                            {r.relation_label}
                            <ArrowRight className="size-3" />
                          </span>
                          <span className="font-medium text-foreground">{r.dst}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              )}
              <div className="relative space-y-3 pl-4 before:absolute before:inset-y-2 before:left-1 before:w-px before:bg-border">
                {detail.notes.map((n, i) => {
                  const date = timelineDate(n.created_at)
                  const prev = i > 0 ? timelineDate(detail.notes[i - 1].created_at) : null
                  const showDate = date !== prev
                  return (
                    <div key={n.id} className="relative">
                      {showDate && (
                        <p className="relative mb-1.5 pt-1 text-xs font-medium text-muted-foreground">
                          <span className="absolute -left-[13.5px] top-2 size-2 rounded-full bg-border" />
                          {date}
                        </p>
                      )}
                      <span className="absolute -left-[13.5px] top-5 size-2 rounded-full bg-primary/60" />
                      <NoteCard note={n} />
                    </div>
                  )
                })}
                {detail.notes.length === 0 && (
                  <p className="py-4 text-sm text-muted-foreground">该线索还没有碎片</p>
                )}
              </div>
            </>
          )
        )}
      </div>
    )
  }

  if (loading) return <NoteListSkeleton />

  if (error)
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-3.5" /> 重试
        </Button>
      </Card>
    )

  if (threads.length === 0)
    return (
      <EmptyState
        icon={GitBranch}
        title="线索还在酦酿"
        description="AI 会把分散数周的同题想法碎片自动串成线索。持续记录，线索会自然浮现。"
        actionLabel="去首页记点想法"
        onAction={() => {
          window.location.hash = "#/"
        }}
      />
    )

  return (
    <div className="space-y-3">
      {threads.map((t) => (
        <Card
          key={t.id}
          className="cursor-pointer p-4 transition-shadow hover:shadow-md"
          onClick={() => setSelected(t.id)}
        >
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="text-[15px] font-medium">{t.title}</h3>
          </div>
          {t.summary && (
            <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{t.summary}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t.note_count} 条碎片 · 更新于 {formatTime(t.updated_at)}
          </p>
        </Card>
      ))}
    </div>
  )
}
