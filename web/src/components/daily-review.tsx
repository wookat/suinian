import { useCallback, useEffect, useRef, useState } from "react"
import { CalendarClock, ChevronDown, ChevronRight, Eye, EyeOff, Sparkles } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ExecGuard } from "@/components/exec-guard"
import { getTodayReview } from "@/lib/api"
import { onReviewNotesChanged } from "@/lib/review-bus"
import { useSettingsVersion } from "@/lib/settings"
import { cn, parseServerTime, titleEchoesContent } from "@/lib/utils"
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
  const d = parseServerTime(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 首页顶部「今日回顾」卡：那年今日 / 上月今日 / 久未回看 / 反复出现的主题 / 悬置的待办，可折叠、可翻下一条 */
export function DailyReview({
  onTagClick,
  onSettled,
}: {
  onTagClick?: (tag: string) => void
  /** 首次加载结束（无论有无条目）时回调：首页据此决定何时显示下方内容，避免卡片后到导致整页下移 */
  onSettled?: () => void
}) {
  const [items, setItems] = useState<DailyReviewItem[]>([])
  const [index, setIndex] = useState(0)
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [loaded, setLoaded] = useState(false)
  const settingsVersion = useSettingsVersion()

  const [refreshKey, setRefreshKey] = useState(0)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

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
        onSettledRef.current?.()
      })
    return () => {
      cancelled = true
    }
  }, [settingsVersion, refreshKey])

  // 删除笔记（含一键清除示例）时即时剔除引用已删除笔记的回顾条目，避免横幅残留
  useEffect(() => {
    return onReviewNotesChanged((deletedIds) => {
      if (deletedIds === null) {
        setRefreshKey((k) => k + 1)
        return
      }
      const dropped = new Set(deletedIds)
      setItems((prev) => {
        const next = prev.filter((it) => !dropped.has(it.note.id))
        // 有条目被剔除时把游标拉回第一条，避免 index 悬空越界
        if (next.length !== prev.length) setIndex(0)
        return next
      })
    })
  }, [])

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
  const sensitive = item.note.is_sensitive === 1
  const revealed = revealedIds.has(item.note.id)
  const masked = sensitive && !revealed

  return (
    <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.04] to-transparent p-0 dark:from-primary/[0.08]">
      <button
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <CalendarClock className="size-4 shrink-0 text-primary" />
        <span role="heading" aria-level={2} className="text-sm font-medium">今日回顾</span>
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
            {/* 标题与正文相同时（短笔记 AI 标题＝原文）只显示一次，与时间流卡片口径一致 */}
            {item.note.title && !masked && !titleEchoesContent(item.note.title, item.note.content) && (
              <p className="mb-1 text-sm font-medium">{item.note.title}</p>
            )}
            {masked ? (
              <button
                onClick={() =>
                  setRevealedIds((s) => new Set(s).add(item.note.id))
                }
                className="flex flex-wrap items-center gap-2 text-left"
              >
                {/* 遮罩圆点不进可访问名（R262 P3-1）：去 aria-label，可见文案即可访问名 */}
                <span aria-hidden="true" className="select-none text-sm leading-7 tracking-widest text-muted-foreground">••••••••••••</span>
                <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-secondary px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                  <Eye className="size-3" /> 敏感内容，点击查看
                </span>
              </button>
            ) : item.note.contains_executable_command ? (
              <ExecGuard compact>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5] overflow-hidden">
                  {item.note.content}
                </p>
              </ExecGuard>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5] overflow-hidden">
                  {item.note.content}
                </p>
                {sensitive && (
                  <button
                    onClick={() =>
                      setRevealedIds((s) => {
                        const next = new Set(s)
                        next.delete(item.note.id)
                        return next
                      })
                    }
                    className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <EyeOff className="size-3" /> 隐藏
                  </button>
                )}
              </>
            )}
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
