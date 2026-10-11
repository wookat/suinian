import { useCallback, useEffect, useRef, useState } from "react"
import { BellRing } from "lucide-react"
import { getTodosToday, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { useRetryOnReconnect } from "@/lib/use-retry-on-reconnect"

/**
 * 时间流顶部的今日待办提醒条：打开应用必然看到，作为 Web Push（依赖授权且
 * iOS 需加主屏）之外的应用内兜底提醒。失败/无待办时不占位。
 */
export function DueTodosBanner({ onSettled }: { onSettled?: () => void } = {}) {
  const [counts, setCounts] = useState<{ due: number; overdue: number } | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const settingsVersion = useSettingsVersion()
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  useEffect(() => {
    let cancelled = false
    getTodosToday()
      .then((res) => {
        if (cancelled) return
        const overdueShown = res.items.filter((i) => i.overdue).length
        // 列表有上限，逾期总数以服务端计数为准（老服务端无该字段时退回列表内计数）
        setCounts({ due: res.items.length - overdueShown, overdue: res.overdue_total ?? overdueShown })
        setUnreachable(false)
      })
      .catch((e: unknown) => {
        /* 提醒条是兜底能力：加载失败时静默隐藏；连不上服务端则等恢复后自动重拉 */
        if (!cancelled) setUnreachable(e instanceof NetworkError)
      })
      .finally(() => onSettledRef.current?.())
    return () => {
      cancelled = true
    }
  }, [settingsVersion, attempt])

  useRetryOnReconnect(unreachable, retry)

  if (!counts || counts.due + counts.overdue === 0) return null
  return (
    <a
      href="#/todos"
      className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
    >
      <BellRing className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {counts.overdue > 0 && `${counts.overdue} 条待办已逾期`}
        {counts.overdue > 0 && counts.due > 0 && "，"}
        {counts.due > 0 && `${counts.due} 条今天到期`}
      </span>
      <span className="ml-auto shrink-0 font-medium">去处理 →</span>
    </a>
  )
}
