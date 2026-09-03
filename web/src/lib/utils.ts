import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 短笔记的 AI 标题常常就是原文（或只差末尾标点）：这种标题不携带增量
 * 信息，展示两遍是视觉冗余。归一化首尾空白与末尾标点后比较。
 */
export function titleEchoesContent(title: string | null | undefined, content: string): boolean {
  if (!title) return false
  const norm = (s: string) => s.trim().replace(/[。．.!！?？~～\s]+$/, "")
  return norm(title) === norm(content)
}

/**
 * 产品安全承诺（R312，按信任域分层）：不承诺认得出每一种危险内容（检测器只决定折叠优先级），
 * 承诺的是结构性边界：聚合/对外出口（跨笔记问答、周报回顾线索、推送、导出中的 AI 文本、工具接口）
 * 不逐字转写笔记；单笔记直答时原文只与它的笔记卡片同屏出现。
 */
export const SAFETY_PROMISE =
  "什么都能丢：我们不保证认得出每一种危险内容，但保证跨笔记聚合、推送、导出与工具接口不会逐字转写你的笔记；你问某条自己的笔记时，原文只会连同它的笔记卡片一起出现，口令/密钥类短串在问答区也只给占位。含远程地址/取回执行原语/编码串/口令密钥的内容默认折叠，一键展开；日常命令备忘直接展示，破坏性命令（rm -rf / dd / DROP TABLE 等）单独高警示。在笔记卡片内复制这类内容（菜单复制、选中后 Ctrl+C/右键复制）都会先提醒核对，请勿直接执行。"

export const EXEC_TITLE_PLACEHOLDER = "含可执行命令的记录（已折叠）"
export const BROAD_TITLE_PLACEHOLDER = "含端点/代码形态内容的记录（已折叠）"
export const CREDENTIAL_TITLE_PLACEHOLDER = "含口令/密钥类内容的记录（已折叠）"

export interface FoldableNote {
  title?: string | null
  content: string
  is_sensitive: number
  contains_executable_command?: boolean
  fold?: boolean
  fold_reason?: string | null
}

export type NoteFoldLevel = "strict" | "broad" | "code" | "destructive" | "credential"

/**
 * 折叠强度（R312 P0-3 → R314 P0-2）：
 * - strict：危险命令（红色警示，默认折叠）；
 * - broad：远程端点 / 取回执行原语 / 编码串 / 混淆书写（中性提示，默认折叠）；
 * - credential：口令/密钥/连接串口令段（默认折叠，建议标为敏感）；
 * - destructive：破坏性命令 rm -rf / dd / DROP TABLE 等（默认展示，高警示横幅，复制前确认）；
 * - code：本机命令行 / SQL 等日常命令备忘（默认展示，复制/执行前警示）。
 */
export function noteFoldLevel(
  n: Pick<FoldableNote, "contains_executable_command" | "fold" | "fold_reason">
): NoteFoldLevel | null {
  if (n.contains_executable_command === true || n.fold_reason === "strict") return "strict"
  if (n.fold === true) {
    if (n.fold_reason === "broad:code") return "code"
    if (n.fold_reason === "broad:destructive") return "destructive"
    if (n.fold_reason === "broad:credential") return "credential"
    return "broad"
  }
  return null
}

/** 笔记是否默认折叠（strict / broad / credential 折；code / destructive 展示但复制时警示） */
export function noteFolded(n: Pick<FoldableNote, "contains_executable_command" | "fold" | "fold_reason">): boolean {
  const level = noteFoldLevel(n)
  return level === "strict" || level === "broad" || level === "credential"
}

/**
 * 笔记在引用卡标签 / 横幅 / 图谱节点等「一行标题位」的展示文本。敏感笔记用
 * 占位；折叠笔记（服务端已把不安全标题置空）绝不回落到正文，按折叠强度用占位；
 * 其余照旧 title→content 回落。
 */
export function noteDisplayLabel(n: FoldableNote, max: number): string {
  if (n.is_sensitive === 1) return "敏感内容"
  const level = noteFoldLevel(n)
  const raw =
    level === "strict"
      ? n.title || EXEC_TITLE_PLACEHOLDER
      : level === "broad"
        ? n.title || BROAD_TITLE_PLACEHOLDER
        : level === "credential"
          ? n.title || CREDENTIAL_TITLE_PLACEHOLDER
          : n.title || n.content || ""
  return raw.replace(/\s+/g, " ").trim().slice(0, max)
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

const NO_OFFSET_SQL_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/

/**
 * Parse a server timestamp into a local Date. The API stores UTC
 * `datetime('now')` values ("YYYY-MM-DD HH:MM:SS", no offset), which
 * `new Date()` would misread as local time.
 */
export function parseServerTime(iso: string): Date {
  const v = iso.trim()
  if (NO_OFFSET_SQL_RE.test(v)) return new Date(`${v.replace(" ", "T")}Z`)
  return new Date(v)
}

export function formatTime(iso: string): string {
  const d = parseServerTime(iso)
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
