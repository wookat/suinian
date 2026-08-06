import { useCallback, useEffect, useMemo, useState } from "react"
import { FileText, Loader2, ChevronLeft, RefreshCw } from "lucide-react"
import { marked } from "marked"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getReports } from "@/lib/api"
import type { WeeklyReport } from "@/lib/types"

function weekLabel(weekStart: string): string {
  const d = new Date(weekStart)
  const end = new Date(d.getTime() + 6 * 86400_000)
  const pad = (n: number) => String(n).padStart(2, "0")
  const fmt = (x: Date) => `${pad(x.getMonth() + 1)}.${pad(x.getDate())}`
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `${d.getFullYear()} `
  return `${year}${fmt(d)} – ${fmt(end)}`
}

function ReportBody({ md }: { md: string }) {
  const html = useMemo(() => marked.parse(md, { async: false }), [md])
  return (
    <div
      className="prose-report text-sm leading-relaxed [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:font-medium [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ReportsPage() {
  const [reports, setReports] = useState<WeeklyReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<WeeklyReport | null>(null)

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
  }, [load])

  if (selected)
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setSelected(null)}>
          <ChevronLeft className="size-4" /> 返回周报列表
        </Button>
        <Card className="p-5">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            {weekLabel(selected.week_start)}
          </p>
          <ReportBody md={selected.content_md} />
        </Card>
      </div>
    )

  if (loading)
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )

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
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <FileText className="size-8 text-muted-foreground" />
        <h2 className="text-base font-medium">每周思考报告</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          每周一自动生成「本周你在想什么」的结构化周报。第一份周报生成后会出现在这里。
        </p>
      </Card>
    )

  return (
    <div className="space-y-3">
      {reports.map((r) => (
        <Card
          key={r.id}
          className="cursor-pointer p-4 transition-shadow hover:shadow-md"
          onClick={() => setSelected(r)}
        >
          <div className="flex items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="text-[15px] font-medium">本周思考报告</h3>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{weekLabel(r.week_start)}</p>
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {r.content_md.replace(/[#*`>\-\n]+/g, " ").trim().slice(0, 120)}
          </p>
        </Card>
      ))}
    </div>
  )
}
