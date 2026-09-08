import type { LucideIcon } from "lucide-react"
import { m } from "motion/react"
import { Button } from "@/components/ui/button"

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  tertiaryActionLabel,
  onTertiaryAction,
}: {
  icon: LucideIcon
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  secondaryActionLabel?: string
  onSecondaryAction?: () => void
  tertiaryActionLabel?: string
  onTertiaryAction?: () => void
}) {
  const hasActions =
    (actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) || (tertiaryActionLabel && onTertiaryAction)
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
      className="relative flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(60%_80%_at_50%_0%,color-mix(in_oklch,var(--color-primary)_14%,transparent),transparent)]"
      />
      <span className="relative flex size-14 items-center justify-center rounded-2xl border bg-background shadow-sm">
        <Icon className="size-6 text-primary" strokeWidth={1.75} />
      </span>
      <h2 className="relative text-base font-semibold tracking-tight">{title}</h2>
      <p className="relative max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
      {hasActions && (
        <div className="relative mt-2 flex flex-wrap justify-center gap-2">
          {actionLabel && onAction && (
            <Button size="sm" variant="outline" onClick={onAction}>
              {actionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <Button size="sm" onClick={onSecondaryAction}>
              {secondaryActionLabel}
            </Button>
          )}
          {tertiaryActionLabel && onTertiaryAction && (
            <Button size="sm" variant="ghost" onClick={onTertiaryAction}>
              {tertiaryActionLabel}
            </Button>
          )}
        </div>
      )}
    </m.div>
  )
}
