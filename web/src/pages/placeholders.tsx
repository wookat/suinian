import { GitBranch, FileText } from "lucide-react"
import { Card } from "@/components/ui/card"

export function ThreadsPage() {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center">
      <GitBranch className="size-8 text-muted-foreground" />
      <h2 className="text-base font-medium">思考线索</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        AI 会把分散数周的同题想法碎片自动串成一条可回看的思考线索。该功能在 R2
        实装，敬请期待。
      </p>
    </Card>
  )
}

export function ReportsPage() {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center">
      <FileText className="size-8 text-muted-foreground" />
      <h2 className="text-base font-medium">每周思考报告</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        每周一自动生成「本周你在想什么」的结构化周报。该功能在 R2 实装，敬请期待。
      </p>
    </Card>
  )
}
