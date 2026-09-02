import { useEffect, useRef, useState } from "react"
import { BellRing } from "lucide-react"
import { getTodosToday } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"

/**
 * 时间流顶部的今日待办提醒条：打开应用必然看到，作为 Web Push（依赖授权且
 * iOS 需加主屏）之外的应用内兜底提醒。失败/无待办时不占位。
 */
export function DueTodosBanner({ onSettled }: { onSettled?: () => void } = {}) {
  const [counts, setCounts] = useState<{ due: number; overdue: number } | null>(null)
  const settingsVersion = useSettingsVersion()
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  useEffect(() => {
    let cancelled = false
    getTodosToday()
      .then((res) => {
        if (cancelled) return
        const overdue = res.items.filter((i) => i.overdue).length
        setCounts({ due: res.items.length - overdue, overdue })
      })
      .catch(() => {
        /* 提醒条是兜底能力：加载失败时静默隐藏 */
      })
      .finally(() => onSettledRef.current?.())
    return () => {
      cancelled = true
    }
  }, [settingsVersion])

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
