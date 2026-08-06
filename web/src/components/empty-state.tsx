import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center animate-in fade-in duration-300">
      <span className="flex size-14 items-center justify-center rounded-full bg-accent">
        <Icon className="size-7 text-accent-foreground" />
      </span>
      <h2 className="text-base font-medium">{title}</h2>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {actionLabel && onAction && (
        <Button size="sm" variant="outline" className="mt-1" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </Card>
  )
}
