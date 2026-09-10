import { useCallback, useEffect, useMemo, useState } from "react"
import { Hash, BarChart3, GitBranch } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getStats, getThreads, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { onNotesMutated } from "@/lib/notes-bus"
import { useRetryOnReconnect } from "@/lib/use-retry-on-reconnect"
import type { Thread } from "@/lib/types"

const MAX_RAIL_THREADS = 3

const MAX_RAIL_TAGS = 20

/** 连续写操作（批量删除 / 撤销恢复）合并成一次重拉 */
const REFRESH_DEBOUNCE_MS = 400

export function RightRail() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [globalStats, setGlobalStats] = useState<{ total: number; days: number } | null>(null)
  const [topTags, setTopTags] = useState<{ tag: string; count: number }[]>([])
  const settingsVersion = useSettingsVersion()
  const [mutationVersion, setMutationVersion] = useState(0)
  const [unreachable, setUnreachable] = useState(false)
  const retry = useCallback(() => setMutationVersion((v) => v + 1), [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onNotesMutated(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setMutationVersion((v) => v + 1)
      }, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let netFail = false
    let settled = 0
    const settle = (e?: unknown) => {
      if (e instanceof NetworkError) netFail = true
      settled += 1
      if (settled === 2 && !cancelled) setUnreachable(netFail)
    }
    getStats()
      .then(
        (res) => {
          if (cancelled) return
          setGlobalStats({
            total: res.total_notes,
            days: res.active_days ?? res.daily.filter((d) => d.count > 0).length,
          })
          setTopTags(res.top_tags ?? [])
        },
        (e: unknown) => {
          if (!cancelled) {
            setGlobalStats(null)
            setTopTags([])
          }
          return e
        },
      )
      .then(settle)
    getThreads()
      .then(
        (res) => {
          if (!cancelled) setThreads(res.threads.slice(0, MAX_RAIL_THREADS))
        },
        (e: unknown) => {
          if (!cancelled) setThreads([])
          return e
        },
      )
      .then(settle)
    return () => {
      cancelled = true
    }
  }, [settingsVersion, mutationVersion])

  useRetryOnReconnect(unreachable, retry)

  // 全局聚合的 top_tags，而非前 100 条采样计数
  const tags = useMemo(
    () => topTags.slice(0, MAX_RAIL_TAGS).map((t) => [t.tag, t.count] as const),
    [topTags],
  )

  const stats = globalStats

  if (!stats || stats.total === 0) return null

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
      {threads.length > 0 && (
        <Card className="p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <GitBranch className="size-4 text-muted-foreground" /> 最近线索
          </h2>
          <div className="mt-3 space-y-1">
            {threads.map((t) => (
              <a
                key={t.id}
                href={`#/threads?id=${encodeURIComponent(t.id)}`}
                className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
              >
                <p className="truncate text-sm font-medium">{t.title}</p>
                <p className="text-xs text-muted-foreground">{t.note_count} 条碎念</p>
              </a>
            ))}
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
