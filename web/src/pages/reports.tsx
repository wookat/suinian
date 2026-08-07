import { useCallback, useEffect, useMemo, useState } from "react"
import { FileText, ChevronLeft, RefreshCw, Loader2, Sparkles } from "lucide-react"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { marked } from "marked"
import DOMPurify from "dompurify"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getReports, getReport, generateReport } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import type { WeeklyReport } from "@/lib/types"

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
    try {
      const report = await generateReport("this")
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
            <Sparkles /> 生成本周报告
          </>
        )}
      </Button>
      {generateError && <p className="text-sm text-destructive">{generateError}</p>}
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
          <ChevronLeft className="size-4" /> 返回周报列表
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
              <h2 className="text-lg font-semibold">
                第 {isoWeekNumber(selected.week_start)} 周思考报告
              </h2>
              <p className="mb-4 mt-1 text-xs font-medium text-muted-foreground">
                {weekLabel(selected.week_start)}
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

  if (reports.length === 0)
    return (
      <div className="space-y-4">
        <EmptyState
          icon={FileText}
          title="周报还未生成"
          description="每周一自动生成「本周你在想什么」的结构化周报；也可以随时手动生成本周的报告。"
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
      {generateButton}
      {reports.map((r) => (
        <Card
          key={r.id}
          className="cursor-pointer p-4 transition-shadow hover:shadow-md"
          onClick={() => setSelectedId(r.id)}
        >
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="text-[15px] font-medium">
              第 {isoWeekNumber(r.week_start)} 周思考报告
            </h3>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{weekLabel(r.week_start)}</p>
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
