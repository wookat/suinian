import * as React from "react"
import { ResponsiveContainer } from "recharts"
import { cn } from "@/lib/utils"

export const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const

export function chartColor(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]
}

/** 固定高度 + 响应宽度的图表容器；SVG 文本继承 muted 色与 xs 字号 */
export function ChartContainer({
  className,
  height = 200,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  height?: number
  children: React.ReactElement
}) {
  return (
    <div
      data-slot="chart"
      className={cn(
        "w-full text-xs text-muted-foreground [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/70 [&_.recharts-surface]:outline-none",
        className,
      )}
      style={{ height }}
      {...props}
    >
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  )
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean
  payload?: ReadonlyArray<{ name?: string | number; value?: number | string; color?: string; payload?: unknown }>
  label?: string | number
  formatter?: (value: number | string, name: string | number | undefined) => string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="min-w-[8rem] rounded-lg border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md">
      {label != null && label !== "" && <p className="mb-1 font-medium">{label}</p>}
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-medium tabular-nums">
              {formatter ? formatter(p.value ?? "", p.name) : p.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
