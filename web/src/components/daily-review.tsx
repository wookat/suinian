import { useCallback, useEffect, useState } from "react"
import { CalendarClock, ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getTodayReview } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { DailyReviewItem } from "@/lib/types"

const COLLAPSE_KEY = "suinian.review.collapsed"

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1"
  } catch {
    return false
  }
}

function noteDateLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 首页顶部「今日回顾」卡：那年今日 / 上月今日 / 久未回看 / 反复出现的主题 / 悬置的待办，可折叠、可翻下一条 */
export function DailyReview({ onTagClick }: { onTagClick?: (tag: string) => void }) {
  const [items, setItems] = useState<DailyReviewItem[]>([])
  const [index, setIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [loaded, setLoaded] = useState(false)
  const settingsVersion = useSettingsVersion()

  useEffect(() => {
    let cancelled = false
    getTodayReview()
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setIndex(0)
      })
      .catch(() => {
        /* 回顾是锦上添花：加载失败时静默隐藏 */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [settingsVersion])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0")
      } catch {
        /* localStorage unavailable */
      }
      return next
    })
  }, [])

  if (!loaded || items.length === 0) return null
  const item = items[index]

  return (
    <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.04] to-transparent p-0 dark:from-primary/[0.08]">
      <button
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <CalendarClock className="size-4 shrink-0 text-primary" />
        <span className="text-sm font-medium">今日回顾</span>
        <Badge variant="outline" className="border-primary/30 text-xs text-primary">
          {item.kind_label}
        </Badge>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {items.length > 1 && `${index + 1}/${items.length}`}
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-2.5 px-4 pb-4">
          {item.comment && (
            <p className="flex items-start gap-1.5 text-sm text-primary/90">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" />
              {item.comment}
            </p>
          )}
          <div className="rounded-lg border bg-card/60 p-3">
            {item.note.title && <p className="mb-1 text-sm font-medium">{item.note.title}</p>}
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5] overflow-hidden">
              {item.note.content}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                记于 {noteDateLabel(item.note.created_at)}
              </span>
              {item.note.tags.slice(0, 3).map((t) => (
                <Badge
                  key={t}
                  variant="outline"
                  className={cn("text-xs", onTagClick && "cursor-pointer hover:bg-accent")}
                  onClick={() => onTagClick?.(t)}
                >
                  #{t}
                </Badge>
              ))}
            </div>
          </div>
          {items.length > 1 && (
            <button
              onClick={() => setIndex((i) => (i + 1) % items.length)}
              className="text-xs font-medium text-primary hover:underline"
            >
              翻下一条 →
            </button>
          )}
        </div>
      )}
    </Card>
  )
}
