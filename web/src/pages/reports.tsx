import { useCallback, useEffect, useMemo, useState } from "react"
import { m } from "motion/react"
import { FileText, ChevronLeft, ChevronRight, RefreshCw, Loader2, Sparkles, CalendarDays } from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { marked } from "marked"
import { sanitizeGeneratedHtml } from "@/lib/safe-html"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { parseServerTime } from "@/lib/utils"
import { getReports, getReport, generateReport, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import { useRetryOnReconnect } from "@/lib/use-retry-on-reconnect"
import type { ReportPeriod, WeeklyReport } from "@/lib/types"

function weekLabel(weekStart: string): string {
  const d = new Date(weekStart)
  const end = new Date(d.getTime() + 6 * 86400_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  const fmt = (x: Date) => `${pad(x.getMonth() + 1)}.${pad(x.getDate())}`
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()} `
  return `${year}${fmt(d)} – ${fmt(end)}`
}

function isoWeekNumber(weekStart: string): number {
  const d = new Date(weekStart)
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum)
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1)
  return Math.ceil(((target.getTime() - yearStart) / 86400_000 + 1) / 7)
}

function monthTitle(monthStart: string): string {
  const d = new Date(monthStart)
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()} 年 `
  return `${year}${d.getMonth() + 1} 月思考报告`
}

function monthLabel(monthStart: string): string {
  const d = new Date(monthStart)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}`
}

function reportPeriod(r: WeeklyReport): ReportPeriod {
  return r.period === "month" ? "month" : "week"
}

function formatGeneratedAt(createdAt: string): string {
  const d = parseServerTime(createdAt)
  if (Number.isNaN(d.getTime())) return createdAt.slice(0, 16)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function reportTitle(r: WeeklyReport): string {
  return reportPeriod(r) === "month" ? monthTitle(r.week_start) : `第 ${isoWeekNumber(r.week_start)} 周思考报告`
}

function reportRangeLabel(r: WeeklyReport): string {
  return reportPeriod(r) === "month" ? monthLabel(r.week_start) : weekLabel(r.week_start)
}

// Strip a leading H1 from report markdown; the page header already shows the title
function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, "")
}

function ReportBody({ md }: { md: string }) {
  const html = useMemo(() => sanitizeGeneratedHtml(marked.parse(md, { async: false })), [md])
  return (
    <div
      className="prose-report text-[15px] leading-[1.75] [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2.5 [&_h2]:mt-7 [&_h2]:border-b [&_h2]:pb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0 [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:font-medium [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ReportsPage() {
  const [reports, setReports] = useState<WeeklyReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WeeklyReport | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [generateNotice, setGenerateNotice] = useState<string | null>(null)
  const [periodTab, setPeriodTab] = useState<ReportPeriod>("week")
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setUnreachable(false)
    try {
      const res = await getReports()
      setReports(res.reports)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setUnreachable(e instanceof NetworkError)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  useRetryOnReconnect(!loading && error !== null && unreachable, load)

  async function handleGenerate() {
    if (generating) return
    setGenerating(true)
    setGenerateError(null)
    setGenerateNotice(null)
    try {
      const { report, message } = await generateReport("this", periodTab)
      if (!report) {
        setGenerateNotice(message ?? "当前周期还没有记录，先去记几条碎念吧")
        return
      }
      await load()
      setSelectedId(report.id)
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : "生成失败，请稍后重试")
    } finally {
      setGenerating(false)
    }
  }

  const generateButton = (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleGenerate()}
        disabled={generating}
        className="w-full sm:w-auto"
      >
        {generating ? (
          <>
            <Loader2 className="animate-spin" /> 生成中，约需半分钟…
          </>
        ) : (
          <>
            <Sparkles /> {periodTab === "month" ? "生成本月报告" : "生成本周报告"}
          </>
        )}
      </Button>
      <p className="text-xs text-muted-foreground">同一周期重复生成会覆盖更新已有报告</p>
      {generateError && (
        <p role="alert" className="text-sm text-destructive">
          {generateError}
        </p>
      )}
      {generateNotice && (
        <p role="status" className="text-sm text-muted-foreground">
          {generateNotice}
        </p>
      )}
    </div>
  )

  useEffect(() => {
    if (!selectedId) {
      setSelected(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    getReport(selectedId)
      .then((r) => {
        if (!cancelled) setSelected(r)
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
  }, [selectedId, detailAttempt])

  if (selectedId)
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setSelectedId(null)}>
          <ChevronLeft className="size-4" /> 返回报告列表
        </Button>
        {detailLoading ? (
          <NoteListSkeleton />
        ) : detailError ? (
          <Card className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-sm text-destructive">{detailError}</p>
            <Button size="sm" variant="outline" onClick={() => setDetailAttempt((n) => n + 1)}>
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          </Card>
        ) : (
          selected && (
            <Card className="p-5 sm:p-7">
              <div className="mb-5 border-b pb-4">
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  <CalendarDays className="size-3" />
                  {reportRangeLabel(selected)}
                </span>
                <h2 className="text-display mt-3 text-xl font-semibold sm:text-2xl">{reportTitle(selected)}</h2>
                {selected.created_at && (
                  <p className="mt-1.5 text-xs text-muted-foreground">生成于 {formatGeneratedAt(selected.created_at)}</p>
                )}
              </div>
              {selected.content_md ? (
                <ReportBody md={stripLeadingH1(selected.content_md)} />
              ) : (
                <p className="text-sm text-muted-foreground">该周报暂无内容</p>
              )}
            </Card>
          )
        )}
      </div>
    )

  const visible = reports.filter((r) => reportPeriod(r) === periodTab)

  const periodTabs = (
    <Tabs value={periodTab} onValueChange={(v) => setPeriodTab(v as ReportPeriod)}>
      <TabsList aria-label="报告类型">
        <TabsTrigger value="week">周报</TabsTrigger>
        <TabsTrigger value="month">月报</TabsTrigger>
      </TabsList>
    </Tabs>
  )

  if (loading) return <NoteListSkeleton />

  if (error)
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-destructive">
          {error}
          {unreachable ? "（会自动重试）" : ""}
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-3.5" /> 重试
        </Button>
      </Card>
    )

  if (visible.length === 0)
    return (
      <div className="space-y-4">
        {periodTabs}
        <EmptyState
          icon={FileText}
          title={periodTab === "month" ? "月报还未生成" : "周报还未生成"}
          description={
            periodTab === "month"
              ? "每月 1 日自动生成上个月的思考月报；也可以随时手动生成本月的报告。"
              : "每周一自动生成「本周你在想什么」的结构化周报；也可以随时手动生成本周的报告。"
          }
          actionLabel="去首页记点想法"
          onAction={() => {
            window.location.hash = "#/"
          }}
        />
        <div className="flex justify-center">{generateButton}</div>
      </div>
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {periodTabs}
        {generateButton}
      </div>
      <div className="space-y-3">
        {visible.map((r, i) => (
          <m.div
            key={r.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i, 6) * 0.04, ease: [0.25, 1, 0.5, 1] }}
          >
            <Card
              interactive
              role="button"
              tabIndex={0}
              className="group cursor-pointer p-4 sm:p-5"
              onClick={() => setSelectedId(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  setSelectedId(r.id)
                }
              }}
            >
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="truncate text-[15px] font-semibold">{reportTitle(r)}</h2>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{reportRangeLabel(r)}</p>
                  {r.content_md && (
                    <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                      {r.content_md.replace(/[#*`>\-\n]+/g, " ").trim().slice(0, 120)}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </m.div>
        ))}
      </div>
    </div>
  )
}
