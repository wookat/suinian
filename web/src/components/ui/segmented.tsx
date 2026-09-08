import * as React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}

interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  "aria-label": string;
  className?: string;
  /** allow the pill row to wrap onto multiple lines (many options) */
  wrap?: boolean;
}

/**
 * Radiogroup-semantics segmented control (theme / font size / data source…),
 * with a spring-animated active pill shared between options.
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  wrap = false,
  ...props
}: SegmentedProps<T>) {
  const layoutId = React.useId();
  return (
    <div
      role="radiogroup"
      aria-label={props["aria-label"]}
      className={cn(
        "flex gap-1 rounded-lg bg-muted p-1",
        wrap && "flex-wrap",
        className,
      )}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const idx = options.findIndex((o) => o.value === value);
        const next =
          options[
            (idx + (e.key === "ArrowRight" ? 1 : -1) + options.length) %
              options.length
          ];
        onValueChange(next.value);
        const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
          `[data-value="${next.value}"]`,
        );
        el?.focus();
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-value={opt.value}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              "relative flex min-h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:px-3",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                aria-hidden
                className="absolute inset-0 rounded-md bg-card shadow-sm"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {Icon && <Icon className="size-3.5" />}
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
