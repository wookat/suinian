import { useCallback, useEffect, useState } from "react"
import { GitBranch, Loader2, ChevronLeft, RefreshCw } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NoteCard } from "@/components/note-card"
import { getThreads, getThread } from "@/lib/api"
import { formatTime } from "@/lib/utils"
import type { Thread, ThreadDetail } from "@/lib/types"

export function ThreadsPage() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ThreadDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

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
  }, [load])

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
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
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
              <div className="relative space-y-3 pl-4 before:absolute before:inset-y-2 before:left-1 before:w-px before:bg-border">
                {detail.notes.map((n) => (
                  <div key={n.id} className="relative">
                    <span className="absolute -left-[13.5px] top-5 size-2 rounded-full bg-primary/60" />
                    <NoteCard note={n} />
                  </div>
                ))}
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

  if (loading)
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )

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
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <GitBranch className="size-8 text-muted-foreground" />
        <h2 className="text-base font-medium">思考线索</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          AI 会把分散数周的同题想法碎片自动串成线索。持续记录，线索会自然浮现。
        </p>
      </Card>
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
