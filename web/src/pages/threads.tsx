import { useCallback, useEffect, useRef, useState } from "react"
import { GitBranch, ChevronLeft, RefreshCw, Network, Loader2 } from "lucide-react"
import { ThreadGraphView } from "@/components/thread-graph"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NoteCard } from "@/components/note-card"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import {
  getThreads,
  getThread,
  startThreadRebuild,
  getThreadRebuildJob,
  getLatestThreadRebuildJob,
  getNotes,
} from "@/lib/api"
import { loadSettings, useSettingsVersion } from "@/lib/settings"
import { formatTime, parseServerTime } from "@/lib/utils"
import type { Thread, ThreadDetail, ThreadJob } from "@/lib/types"

const JOB_POLL_MS = 3000

// 重建耗时量级预期：生产实测约 2.5s/条（R139：1000 条 ≈ 42 分钟）
function rebuildEta(total: number): string {
  const min = Math.ceil((total * 2.6) / 60)
  return min >= 2 ? `（预计约 ${min} 分钟，可离开本页稍后再看）` : ""
}

const PHASE_LABEL: Record<ThreadJob["phase"], string> = {
  reset: "准备中",
  cluster: "聚类中",
  second_pass: "补充归类",
  summarize: "生成摘要",
  done: "完成",
}

/** 线索时间跨度：首条→最新条相隔天数，体现想法陈酿了多久 */
function spanLabel(first?: string | null, last?: string | null): string | null {
  if (!first || !last) return null
  const days = Math.round(
    (parseServerTime(last).getTime() - parseServerTime(first).getTime()) / 86400_000,
  )
  if (days < 1) return null
  if (days < 30) return `跨越 ${days} 天`
  if (days < 365) return `跨越 ${Math.round(days / 30)} 个月`
  return `跨越 ${(days / 365).toFixed(1)} 年`
}

function timelineDate(iso: string): string {
  const d = parseServerTime(iso)
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
  const [highlightedNoteIds, setHighlightedNoteIds] = useState<Set<string>>(new Set())
  const [job, setJob] = useState<ThreadJob | null>(null)
  const [rebuildStarting, setRebuildStarting] = useState(false)
  const [hasIdeaNotes, setHasIdeaNotes] = useState(false)
  const jobTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // restore an in-flight rebuild job after a page refresh
  useEffect(() => {
    if (loadSettings().useMock) return
    let cancelled = false
    void getLatestThreadRebuildJob().then((j) => {
      if (cancelled || !j) return
      if (j.status === "queued" || j.status === "running") setJob(j)
    })
    return () => {
      cancelled = true
    }
  }, [settingsVersion])

  // empty state: only offer the rebuild entry when there are idea notes to cluster
  useEffect(() => {
    if (loading || threads.length > 0 || loadSettings().useMock) {
      setHasIdeaNotes(false)
      return
    }
    let cancelled = false
    getNotes({ category: "idea", limit: 1 })
      .then((res) => {
        if (!cancelled) setHasIdeaNotes(res.notes.length > 0)
      })
      .catch(() => {
        if (!cancelled) setHasIdeaNotes(false)
      })
    return () => {
      cancelled = true
    }
  }, [loading, threads.length, settingsVersion])

  // poll the background rebuild job; refresh the list once it completes
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return
    let cancelled = false
    jobTimer.current = setTimeout(async () => {
      try {
        const next = await getThreadRebuildJob(job.job_id)
        if (cancelled) return
        setJob(next)
        if (next.status === "done") void load()
      } catch {
        if (!cancelled) setJob(null)
      }
    }, JOB_POLL_MS)
    return () => {
      cancelled = true
      if (jobTimer.current) clearTimeout(jobTimer.current)
    }
  }, [job, load])

  const onRebuild = useCallback(async () => {
    setRebuildStarting(true)
    try {
      setJob(await startThreadRebuild())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRebuildStarting(false)
    }
  }, [])

  const jobBanner =
    job && job.status !== "done" && job.status !== "error" ? (
      <Card className="flex items-center gap-3 p-3">
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">后台重建线索中……{PHASE_LABEL[job.phase]}</p>
          <p className="text-xs text-muted-foreground">
            {job.phase === "summarize" && job.summarize_total > 0
              ? `已生成摘要 ${Math.min(job.summarized, job.summarize_total)} / ${job.summarize_total} 条线索`
              : job.total > 0
                ? `已处理 ${Math.min(job.processed, job.total)} / ${job.total} 条想法${rebuildEta(job.total)}`
                : "正在统计待处理的想法……"}
          </p>
        </div>
        {job.phase === "summarize" && job.summarize_total > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {Math.floor((Math.min(job.summarized, job.summarize_total) / job.summarize_total) * 100)}%
          </span>
        ) : job.total > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {Math.floor((Math.min(job.processed, job.total) / job.total) * 100)}%
          </span>
        ) : null}
      </Card>
    ) : job?.status === "error" ? (
      <Card className="p-3">
        <p className="text-sm text-destructive">线索重建失败{job.error ? `：${job.error}` : ""}</p>
      </Card>
    ) : job?.status === "done" ? (
      <Card className="p-3">
        <p className="text-sm">
          {job.summarize_total > 0
            ? `线索重建完成，共聚成 ${job.summarize_total} 条线索。`
            : "线索重建已完成，但现有想法暂未聚成线索（内容较少或主题分散），继续记录后可再试。"}
        </p>
      </Card>
    ) : null

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
    setHighlightedNoteIds(new Set())
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
                  <div className="mt-2.5">
                    <ThreadGraphView
                      graph={detail.graph}
                      notes={detail.notes}
                      highlightedNoteIds={highlightedNoteIds}
                      onHighlightNotes={(ids) => setHighlightedNoteIds(new Set(ids))}
                      onJumpToNote={(id) => {
                        setHighlightedNoteIds(new Set([id]))
                        document
                          .getElementById(`thread-note-${id}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }}
                    />
                  </div>
                </Card>
              )}
              <div className="relative space-y-3 pl-4 before:absolute before:inset-y-2 before:left-1 before:w-px before:bg-border">
                {detail.notes.map((n, i) => {
                  const date = timelineDate(n.created_at)
                  const prev = i > 0 ? timelineDate(detail.notes[i - 1].created_at) : null
                  const showDate = date !== prev
                  return (
                    <div key={n.id} id={`thread-note-${n.id}`} className="relative">
                      {showDate && (
                        <p className="relative mb-2 pt-1">
                          <span className="absolute -left-[14.5px] top-[9px] size-2.5 rounded-full border-2 border-background bg-primary/50" />
                          <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {date}
                          </span>
                        </p>
                      )}
                      <span className="absolute -left-[13.5px] top-5 size-2 rounded-full bg-primary/60" />
                      <NoteCard
                        note={n}
                        className={
                          highlightedNoteIds.has(n.id)
                            ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                            : highlightedNoteIds.size > 0
                              ? "opacity-50"
                              : undefined
                        }
                      />
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

  if (threads.length === 0 && jobBanner) return <div className="space-y-3">{jobBanner}</div>

  if (threads.length === 0)
    return hasIdeaNotes ? (
      <EmptyState
        icon={GitBranch}
        title="线索还在酝酿"
        description="你已经记了一些想法，但还没有串成线索——同一主题通常要积累 2-3 条相关想法才会聚成线索，第一周线索少是正常的。也可以手动触发一次重建，让 AI 立即把同主题的想法串起来。"
        actionLabel="重建线索"
        onAction={() => void onRebuild()}
      />
    ) : (
      <EmptyState
        icon={GitBranch}
        title="线索还在酝酿"
        description="AI 会把分散数周的同题想法碎片自动串成线索——同一主题通常要积累 2-3 条相关想法才会聚成，刚开始的第一周还没有线索是正常的。持续记录，线索会自然浮现。"
        actionLabel="去首页记点想法"
        onAction={() => {
          window.location.hash = "#/"
        }}
      />
    )

  const rebuildRunning = !!job && job.status !== "done" && job.status !== "error"

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          「线索」= AI 把你不同时间记下的同一主题碎念自动串成的合集，方便回看一个想法是如何演化的。
        </p>
        {!loadSettings().useMock && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={rebuildStarting || rebuildRunning}
            onClick={() => void onRebuild()}
          >
            <RefreshCw className="size-3.5" /> 重建线索
          </Button>
        )}
      </div>
      {jobBanner}
      {threads.map((t) => (
        <Card
          key={t.id}
          className="cursor-pointer p-4 transition-shadow hover:shadow-md"
          onClick={() => setSelected(t.id)}
        >
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="min-w-0 flex-1 text-[15px] font-medium">{t.title}</h3>
            {(t.week_new_count ?? 0) > 0 && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                本周 +{t.week_new_count}
              </span>
            )}
          </div>
          {t.summary && (
            <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{t.summary}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t.note_count} 条碎片
            {spanLabel(t.first_note_at, t.last_note_at) && ` · ${spanLabel(t.first_note_at, t.last_note_at)}`}
            {" · 最近记录 "}
            {formatTime(t.last_note_at ?? t.updated_at)}
          </p>
        </Card>
      ))}
      {threads.length <= 2 && (
        <Card className="border-dashed p-4 text-center">
          <p className="text-sm text-muted-foreground">
            更多线索还在酝酿——继续记录想法，AI 会把同主题的碎片自动串成新线索
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => {
              window.location.hash = "#/"
            }}
          >
            去首页记点想法
          </Button>
        </Card>
      )}
    </div>
  )
}
