import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { m } from "motion/react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from "recharts"
import { BarChart3, Dices, Flame, GitBranch, Loader2, RefreshCw, StickyNote, Tag, TrendingUp, Trophy } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ChartContainer, ChartTooltipContent, chartColor } from "@/components/ui/chart"
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

const TREND_DAYS = 30

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
    if (r <= 0.25) return "fill-primary/30"
    if (r <= 0.5) return "fill-primary/55"
    if (r <= 0.75) return "fill-primary/80"
    return "fill-primary"
  }

  const CELL = 11
  const GAP = 3
  const width = weeks.length * (CELL + GAP)
  const height = 7 * (CELL + GAP) + 16

  const openDay = (date: string) => {
    window.location.hash = `#/?date=${date}`
  }

  return (
    <div
      ref={scrollRef}
      className="overflow-x-auto pb-1"
      data-testid="heatmap"
      tabIndex={0}
      role="region"
      aria-label="过去一年每日记录热力图（可横向滚动）"
    >
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
  unit,
  accent,
  index = 0,
}: {
  icon: typeof Flame
  label: string
  value: string
  unit?: string
  accent?: boolean
  index?: number
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05, ease: [0.25, 1, 0.5, 1] }}
    >
      <Card className="flex h-full flex-col gap-2 p-4">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md bg-muted",
              accent && "bg-warning/15 text-warning",
            )}
          >
            <Icon className="size-3.5" />
          </span>
          {label}
        </span>
        <span className="flex items-baseline gap-1">
          <span className={cn("text-display text-3xl font-semibold tabular-nums", accent && "text-warning")}>{value}</span>
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </span>
      </Card>
    </m.div>
  )
}

/** 近 30 天每日记录趋势（面积图） */
function TrendChart({ daily }: { daily: StatsResponse["daily"] }) {
  const data = useMemo(() => {
    const counts = new Map(daily.map((d) => [d.date, d.count]))
    const today = new Date()
    const out: { date: string; label: string; count: number }[] = []
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000)
      const iso = localDateStr(d)
      out.push({ date: iso, label: `${d.getMonth() + 1}/${d.getDate()}`, count: counts.get(iso) ?? 0 })
    }
    return out
  }, [daily])
  const total = data.reduce((s, d) => s + d.count, 0)

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <TrendingUp className="size-4" />
          近 {TREND_DAYS} 天趋势
        </h2>
        <span className="text-xs text-muted-foreground">
          共 <span className="font-medium text-foreground tabular-nums">{total}</span> 条
        </span>
      </div>
      <ChartContainer height={180} aria-label={`近 ${TREND_DAYS} 天每日记录数趋势图`} role="img">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval={6} tickMargin={8} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            cursor={{ stroke: "var(--color-border)" }}
            content={<ChartTooltipContent formatter={(v) => `${v} 条`} />}
          />
          <Area
            type="monotone"
            dataKey="count"
            name="记录"
            stroke="var(--color-primary)"
            strokeWidth={2}
            fill="url(#trend-fill)"
            activeDot={{ r: 4, strokeWidth: 0 }}
            isAnimationActive={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
          />
        </AreaChart>
      </ChartContainer>
    </Card>
  )
}

/** 横向条形分布（分类/来源共用） */
function DistBars({
  title,
  items,
}: {
  title: string
  items: { key: string; label: string; count: number }[]
}) {
  const total = items.reduce((s, i) => s + i.count, 0)
  if (total === 0) return null
  const data = [...items].sort((a, b) => b.count - a.count)
  const height = Math.max(120, data.length * 34 + 12)
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{title}</h2>
      <ChartContainer height={height} aria-label={`${title}条形图`} role="img">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 36, left: 0, bottom: 0 }} barCategoryGap={8}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={72} tickLine={false} axisLine={false} tick={{ fill: "var(--color-foreground)" }} />
          <Tooltip
            cursor={{ fill: "var(--color-muted)", radius: 6 }}
            content={<ChartTooltipContent formatter={(v) => `${v} 条 · ${Math.round((Number(v) / total) * 100)}%`} />}
          />
          <Bar
            dataKey="count"
            name="数量"
            radius={[0, 6, 6, 0]}
            maxBarSize={22}
            label={{ position: "right", fill: "var(--color-muted-foreground)", fontSize: 11 }}
            isAnimationActive={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
          >
            {data.map((d, i) => (
              <Cell key={d.key} fill={chartColor(i)} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <ul className="sr-only">
        {data.map((it) => (
          <li key={it.key}>
            {it.label}：{it.count} 条
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
      else if (e instanceof NetworkError) setError(e.message)
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
      <div className="space-y-5" aria-busy="true" aria-label="正在加载统计">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
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
      <span className="font-medium text-muted-foreground">洞察范围</span>
      <Select value={String(scopeDays)} onValueChange={(v) => setScopeDays(Number(v))}>
        <SelectTrigger size="sm" aria-label="时间范围">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCOPE_DAYS_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {allTags.length > 0 && (
        <Select value={scopeTag || "__all"} onValueChange={(v) => setScopeTag(v === "__all" ? "" : v)}>
          <SelectTrigger size="sm" aria-label="标签范围" className="max-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部标签</SelectItem>
            {allTags.map((t) => (
              <SelectItem key={t} value={t}>
                #{t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {scoped && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          onClick={() => {
            setScopeDays(0)
            setScopeTag("")
          }}
        >
          重置
        </Button>
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
        <StatTile icon={Flame} label="当前连续记录" value={String(stats.streak.current)} unit="天" accent index={0} />
        <StatTile icon={Trophy} label="最长连续记录" value={String(stats.streak.longest)} unit="天" index={1} />
        <StatTile icon={StickyNote} label="总笔记数" value={String(stats.total_notes)} unit="条" index={2} />
        <StatTile icon={GitBranch} label="思考线索" value={String(stats.thread_count)} unit="条" index={3} />
      </div>

      {/* 趋势 */}
      <TrendChart daily={stats.daily} />

      {/* 热力图 */}
      <Card className="space-y-2 p-4">
        <h2 className="text-sm font-medium">过去一年的记录</h2>
        <Heatmap daily={stats.daily} />
        <p className="text-xs text-muted-foreground">点击某一天可跳转到当天的笔记列表</p>
      </Card>

      {/* 随机漫步 */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Dices className="size-4" />
            随机漫步
          </h2>
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
          <h2 className="flex items-center gap-1.5 text-sm font-medium">
            <Tag className="size-4" />
            常用标签
          </h2>
          <div className="flex flex-wrap gap-2">
            {stats.top_tags.map((t) => (
              <a
                key={t.tag}
                href={`#/?tag=${encodeURIComponent(t.tag)}`}
                className="hit-44 inline-flex min-h-8 items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-xs transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
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
