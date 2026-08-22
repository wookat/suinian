import { useCallback, useEffect, useMemo, useState } from "react"
import { FileText, ChevronLeft, RefreshCw, Loader2, Sparkles } from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { marked } from "marked"
import DOMPurify from "dompurify"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { cn, parseServerTime } from "@/lib/utils"
import { getReports, getReport, generateReport } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
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
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(md, { async: false })), [md])
  return (
    <div
      className="prose-report text-sm leading-relaxed [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2.5 [&_h2]:mt-7 [&_h2]:border-b [&_h2]:pb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0 [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:font-medium [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ReportsPage() {
  const [reports, setReports] = useState<WeeklyReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WeeklyReport | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [generateNotice, setGenerateNotice] = useState<string | null>(null)
  const [periodTab, setPeriodTab] = useState<ReportPeriod>("week")
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getReports()
      setReports(res.reports)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

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
      {generateError && <p className="text-sm text-destructive">{generateError}</p>}
      {generateNotice && <p className="text-sm text-muted-foreground">{generateNotice}</p>}
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
  }, [selectedId])

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
          </Card>
        ) : (
          selected && (
            <Card className="p-5">
              <h2 className="text-lg font-semibold">{reportTitle(selected)}</h2>
              <p className="mb-4 mt-1 text-xs font-medium text-muted-foreground">
                覆盖 {reportRangeLabel(selected)}
                {selected.created_at ? ` · 生成于 ${formatGeneratedAt(selected.created_at)}` : ""}
              </p>
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
    <div className="flex w-fit gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="报告类型">
      {(
        [
          { value: "week", label: "周报" },
          { value: "month", label: "月报" },
        ] as const
      ).map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={periodTab === t.value}
          onClick={() => setPeriodTab(t.value)}
          className={cn(
            "rounded-md px-3 py-1 text-sm font-medium transition-colors",
            periodTab === t.value ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )

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
    <div className="space-y-3">
      {periodTabs}
      {generateButton}
      {visible.map((r) => (
        <Card
          key={r.id}
          className="cursor-pointer p-4 transition-shadow hover:shadow-md"
          onClick={() => setSelectedId(r.id)}
        >
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h2 className="text-[15px] font-medium">{reportTitle(r)}</h2>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{reportRangeLabel(r)}</p>
          {r.content_md && (
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {r.content_md.replace(/[#*`>\-\n]+/g, " ").trim().slice(0, 120)}
            </p>
          )}
        </Card>
      ))}
    </div>
  )
}
