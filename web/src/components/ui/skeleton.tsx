import * as React from "react"
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("skeleton-shimmer rounded-md", className)} {...props} />
}

function NoteCardSkeleton() {
  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
        <Skeleton className="h-3.5 w-16" />
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  )
}

const SLOW_LOAD_HINT_MS = 5000

function NoteListSkeleton({ count = 3 }: { count?: number }) {
  const [slow, setSlow] = React.useState(false)
  React.useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_LOAD_HINT_MS)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="space-y-3" role="status" aria-label="加载中">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stagger-in" style={{ "--i": i } as React.CSSProperties}>
          <NoteCardSkeleton />
        </div>
      ))}
      {slow && (
        <p className="text-center text-sm text-muted-foreground" aria-live="polite">
          加载时间较长，可能是网络较慢，正在继续尝试……
        </p>
      )}
    </div>
  )
}

export { Skeleton, NoteCardSkeleton, NoteListSkeleton }
