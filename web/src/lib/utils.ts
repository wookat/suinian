import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const HAS_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * Parse a todo_due into a local Date: date-only values are local calendar
 * dates; offset-less datetimes are Asia/Shanghai (+08:00) local times.
 */
export function parseDue(due: string): Date {
  const v = due.trim()
  if (DATE_ONLY_RE.test(v)) {
    const [y, m, d] = v.split("-").map(Number)
    return new Date(y, m - 1, d)
  }
  const iso = v.replace(" ", "T")
  return new Date(HAS_OFFSET_RE.test(iso) ? iso : `${iso}+08:00`)
}

/** Does the due string carry a time-of-day (vs date-only)? */
export function dueHasTime(due: string): boolean {
  return /[T ]\d{2}:\d{2}/.test(due)
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return "刚刚"
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24 && d.getDate() === now.getDate()) return `${hr} 小时前`
  const y = d.getFullYear()
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (y === now.getFullYear()) return `${date} ${time}`
  return `${y}-${date} ${time}`
}
