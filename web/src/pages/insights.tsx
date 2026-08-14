import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BarChart3, Dices, Flame, GitBranch, Loader2, RefreshCw, StickyNote, Tag, Trophy } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NoteCard } from "@/components/note-card"
import { EmptyState } from "@/components/empty-state"
import { getRandomNote, getStats, ApiError, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { Note, StatsResponse } from "@/lib/types"

const CATEGORY_LABEL: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
  expense: "支出",
  income: "收入",
  transfer: "资金往来",
  pending: "待分拣",
}

const SOURCE_LABEL: Record<string, string> = {
  wechat: "微信",
  android: "Android",
  web: "Web 速记",
  api: "API",
  extension: "浏览器剪藏",
  "from-ask": "问答存档",
  import: "导入",
  mcp: "MCP",
}

const SCOPE_DAYS_OPTIONS = [
  { value: 0, label: "全部时间" },
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 365, label: "近 1 年" },
]

const BAR_COLORS = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-lime-500",
  "bg-fuchsia-500",
]

function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** GitHub 风格日历热力图：52 周 x 7 天，点击某天跳该天笔记列表 */
function Heatmap({ daily }: { daily: StatsResponse["daily"] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { weeks, monthLabels, max } = useMemo(() => {
    const counts = new Map(daily.map((d) => [d.date, d.count]))
    const today = new Date()
    // grid ends on today's week (Sunday-first columns like GitHub)
    const end = new Date(today)
    const start = new Date(end.getTime() - 364 * 86400_000)
    start.setDate(start.getDate() - start.getDay()) // back to Sunday
    const weeks: { date: string; count: number; future: boolean }[][] = []
    const monthLabels: { index: number; label: string }[] = []
    let cur = new Date(start)    
    let lastMonth = -1
    while (cur <= end || weeks[weeks.length - 1]?.length !== 7) {
      const iso = localDateStr(cur)
      if (cur.getDay() === 0) {
        weeks.push([])
        if (cur.getMonth() !== lastMonth) {
          monthLabels.push({ index: weeks.length - 1, label: `${cur.getMonth() + 1}月` })
          lastMonth = cur.getMonth()
        }
      }
      weeks[weeks.length - 1].push({ date: iso, count: counts.get(iso) ?? 0, future: cur > today })
      cur = new Date(cur.getTime() + 86400_000)
      if (weeks.length > 54) break
    }
    const max = Math.max(1, ...daily.map((d) => d.count))
    return { weeks, monthLabels, max }
  }, [daily])

  useEffect(() => {
    // most recent weeks live at the right edge
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [weeks])

  const level = (count: number): string => {
    if (count === 0) return "fill-muted"
    const r = count / max
    if (r <= 0.25) return "fill-emerald-300 dark:fill-emerald-900"
    if (r <= 0.5) return "fill-emerald-400 dark:fill-emerald-700"
    if (r <= 0.75) return "fill-emerald-500 dark:fill-emerald-600"
    return "fill-emerald-600 dark:fill-emerald-400"
  }

  const CELL = 11
  const GAP = 3
  const width = weeks.length * (CELL + GAP)
  const height = 7 * (CELL + GAP) + 16

  const openDay = (date: string) => {
    window.location.hash = `#/?date=${date}`
  }

  return (
    <div ref={scrollRef} className="overflow-x-auto pb-1" data-testid="heatmap">
      <svg width={width} height={height} role="img" aria-label="过去一年每日记录热力图">
        {monthLabels.map((m) => (
          <text
            key={`${m.index}-${m.label}`}
            x={m.index * (CELL + GAP)}
            y={10}
            className="fill-muted-foreground text-[9px]"
          >
            {m.label}
          </text>
        ))}
        {weeks.map((week, wi) =>
          week.map((day, di) =>
            day.future ? null : (
              <rect
                key={day.date}
                x={wi * (CELL + GAP)}
                y={16 + di * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2.5}
                className={cn(level(day.count), day.count > 0 && "cursor-pointer hover:stroke-primary hover:stroke-2")}
                onClick={() => day.count > 0 && openDay(day.date)}
              >
                <title>{`${day.date}：${day.count} 条`}</title>
              </rect>
            ),
          ),
        )}
      </svg>
    </div>
  )
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Flame
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5", accent && "text-orange-500")} />
        {label}
      </span>
      <span className={cn("text-2xl font-semibold tabular-nums", accent && "text-orange-500")}>{value}</span>
    </Card>
  )
}

/** 简洁横向条形分布（分类/来源共用） */
function DistBars({
  title,
  items,
}: {
  title: string
  items: { key: string; label: string; count: number }[]
}) {
  const total = items.reduce((s, i) => s + i.count, 0)
  if (total === 0) return null
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {items.map((it, i) => (
          <div
            key={it.key}
            className={cn(BAR_COLORS[i % BAR_COLORS.length])}
            style={{ width: `${(it.count / total) * 100}%` }}
            title={`${it.label} ${it.count}`}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        {items.map((it, i) => (
          <li key={it.key} className="flex items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", BAR_COLORS[i % BAR_COLORS.length])} />
            <span className="truncate text-muted-foreground">{it.label}</span>
            <span className="ml-auto font-medium tabular-nums">{it.count}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function InsightsPage() {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [randomNote, setRandomNote] = useState<Note | null>(null)
  const [randomEmpty, setRandomEmpty] = useState(false)
  const [drawing, setDrawing] = useState(false)
  // 自定义洞察范围（时间×标签，借鉴 flomo）；默认全部
  const [scopeDays, setScopeDays] = useState(0)
  const [scopeTag, setScopeTag] = useState("")
  // 标签候选来自首次不带范围的统计，避免选中后候选列表自身被筛窄
  const [allTags, setAllTags] = useState<string[]>([])
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getStats(365, {
        tag: scopeTag || undefined,
        scopeDays: scopeDays || undefined,
      })
      setStats(res)
      if (!scopeTag && !scopeDays) setAllTags(res.top_tags.map((t) => t.tag))
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403))
        setError("未连接或 token 失效，请到设置页检查连接")
      else if (e instanceof NetworkError) setError("网络连接失败，请检查网络或 API 地址")
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [scopeTag, scopeDays])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  const draw = useCallback(async () => {
    setDrawing(true)
    try {
      const note = await getRandomNote()
      setRandomNote(note)
      setRandomEmpty(note === null)
    } catch {
      setRandomEmpty(true)
    } finally {
      setDrawing(false)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={BarChart3}
        title="加载统计失败"
        description={error}
        actionLabel="重试"
        onAction={() => void load()}
      />
    )
  }

  if (!stats) return null

  const scoped = scopeTag !== "" || scopeDays !== 0

  if (stats.total_notes === 0 && !scoped) {
    return (
      <EmptyState
        icon={BarChart3}
        title="还没有可统计的记录"
        description="去时间流丢下第一条碎念，这里就会长出你的记录热力图与统计全貌。"
        actionLabel="去记一条"
        onAction={() => {
          window.location.hash = "#/"
        }}
      />
    )
  }

  const scopeBar = (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="insight-scope">
      <span className="text-muted-foreground">洞察范围</span>
      <select
        value={scopeDays}
        onChange={(e) => setScopeDays(Number(e.target.value))}
        className="h-7 rounded-md border bg-background px-2"
        aria-label="时间范围"
      >
        {SCOPE_DAYS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {allTags.length > 0 && (
        <select
          value={scopeTag}
          onChange={(e) => setScopeTag(e.target.value)}
          className="h-7 max-w-40 rounded-md border bg-background px-2"
          aria-label="标签范围"
        >
          <option value="">全部标签</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
      )}
      {scoped && (
        <button
          type="button"
          className="text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            setScopeDays(0)
            setScopeTag("")
          }}
        >
          重置
        </button>
      )}
    </div>
  )

  if (stats.total_notes === 0) {
    return (
      <div className="space-y-5">
        {scopeBar}
        <EmptyState icon={BarChart3} title="该范围内没有记录" description="换个时间范围或标签再试试。" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {scopeBar}
      {/* 总览 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile icon={Flame} label="当前连续记录" value={`${stats.streak.current} 天`} accent />
        <StatTile icon={Trophy} label="最长连续记录" value={`${stats.streak.longest} 天`} />
        <StatTile icon={StickyNote} label="总笔记数" value={String(stats.total_notes)} />
        <StatTile icon={GitBranch} label="思考线索" value={String(stats.thread_count)} />
      </div>

      {/* 热力图 */}
      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-medium">过去一年的记录</h3>
        <Heatmap daily={stats.daily} />
        <p className="text-xs text-muted-foreground">点击某一天可跳转到当天的笔记列表</p>
      </Card>

      {/* 随机漫步 */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Dices className="size-4" />
            随机漫步
          </h3>
          <Button size="sm" variant={randomNote ? "outline" : "default"} disabled={drawing} onClick={() => void draw()}>
            {drawing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {randomNote ? "再抽一条" : "抽一条旧笔记"}
          </Button>
        </div>
        {randomNote ? (
          <NoteCard
            note={randomNote}
            onTagClick={(tag) => {
              window.location.hash = `#/?tag=${encodeURIComponent(tag)}`
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {randomEmpty
              ? "暂无可回看的笔记（敏感与示例笔记不参与随机漫步）"
              : "像 flomo 的随机漫步一样，从历史里随机翻出一条旧笔记，让旧想法重新浮现。"}
          </p>
        )}
      </Card>

      {/* 分布 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <DistBars
          title="分类分布"
          items={stats.categories.map((c) => ({
            key: c.category,
            label: CATEGORY_LABEL[c.category] ?? c.category,
            count: c.count,
          }))}
        />
        <DistBars
          title="来源分布"
          items={stats.sources.map((s) => ({
            key: s.source,
            label: SOURCE_LABEL[s.source] ?? s.source,
            count: s.count,
          }))}
        />
      </div>

      {/* 常用标签 */}
      {stats.top_tags.length > 0 && (
        <Card className="space-y-3 p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Tag className="size-4" />
            常用标签
          </h3>
          <div className="flex flex-wrap gap-2">
            {stats.top_tags.map((t) => (
              <a
                key={t.tag}
                href={`#/?tag=${encodeURIComponent(t.tag)}`}
                className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent"
              >
                #{t.tag}
                <span className="text-muted-foreground">{t.count}</span>
              </a>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
