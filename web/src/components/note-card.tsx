import { useEffect, useRef, useState } from "react"
import {
  Lightbulb,
  CheckSquare,
  Bookmark,
  Database,
  Link as LinkIcon,
  MessageCircle,
  Smartphone,
  Globe,
  Webhook,
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  ShieldOff,
  ShieldAlert,
  CalendarClock,
  Loader2,
  Mic,
  Image as ImageIcon,
  Sparkles,
  FileText,
  Download,
  CircleAlert,
  RefreshCw,
  X,
  Wallet,
  Coins,
  ArrowLeftRight,
  Puzzle,
  FolderInput,
  GitBranch,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { downloadNoteFile, refetchLink, retryMedia } from "@/lib/api"
import { NoteAudio, NoteImage, isAudioAttachment, isImageAttachment } from "@/components/note-media"
import { cn, formatTime, parseServerTime, parseDue, dueHasTime, titleEchoesContent } from "@/lib/utils"
import type { Note, NoteCategory, NotePatch } from "@/lib/types"

const CATEGORY_META: Record<
  NoteCategory,
  { label: string; icon: typeof Lightbulb; activeClassName: string }
> = {
  idea: {
    label: "想法",
    icon: Lightbulb,
    activeClassName: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  todo: {
    label: "待办",
    icon: CheckSquare,
    activeClassName: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  collect: {
    label: "收藏",
    icon: Bookmark,
    activeClassName: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  data: {
    label: "资料",
    icon: Database,
    activeClassName: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  expense: {
    label: "支出",
    icon: Wallet,
    activeClassName: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  },
  income: {
    label: "收入",
    icon: Coins,
    activeClassName: "bg-green-500/10 text-green-600 dark:text-green-400",
  },
  transfer: {
    label: "资金往来",
    icon: ArrowLeftRight,
    activeClassName: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
}

const RAW_TYPE_META = {
  voice: { icon: Mic, label: "语音转写" },
  image: { icon: ImageIcon, label: "图片识别" },
  file: { icon: FileText, label: "文件" },
} as const

export function RawTypeBadge({ rawType }: { rawType: string }) {
  const meta = RAW_TYPE_META[rawType as keyof typeof RAW_TYPE_META]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

const SOURCE_META = {
  wechat: { icon: MessageCircle, label: "来自微信" },
  android: { icon: Smartphone, label: "来自 Android" },
  web: { icon: Globe, label: "来自 Web 速记" },
  api: { icon: Webhook, label: "来自 API" },
  extension: { icon: Puzzle, label: "来自浏览器剪藏" },
  "from-ask": { icon: Sparkles, label: "来自问答存档" },
  import: { icon: FolderInput, label: "来自导入" },
  mcp: { icon: Webhook, label: "来自 MCP" },
} as const

export function CategoryBadge({
  category,
  active = false,
}: {
  category: NoteCategory | null
  active?: boolean
}) {
  if (!category) return null
  const meta = CATEGORY_META[category]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        active ? meta.activeClassName : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

export function DueChip({ due }: { due: string | null }) {
  if (!due) return null
  const d = parseDue(due)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const overdue = dueHasTime(due)
    ? d.getTime() < now.getTime()
    : startOfDay(d).getTime() < startOfDay(now).getTime()
  // 临期：24 小时内到期（无时刻的按当天算临期）
  const dueSoon =
    !overdue &&
    (dueHasTime(due)
      ? d.getTime() - now.getTime() <= 24 * 3600 * 1000
      : startOfDay(d).getTime() === startOfDay(now).getTime())
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        overdue
          ? "bg-red-500/15 text-red-600 ring-1 ring-red-500/40 dark:text-red-400"
          : dueSoon
            ? "bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/40 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
      )}
    >
      <CalendarClock className="size-3" />
      {overdue ? "已过期 " : dueSoon ? "临期 " : ""}
      {formatDue(due)}
    </span>
  )
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "JP¥", HKD: "HK$" }

export function formatAmount(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency]
  const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
  return sym ? `${sym}${num}` : `${num} ${currency}`
}

export function AmountChip({ note }: { note: Note }) {
  const merchant = note.meta?.finance_merchant
  const label =
    note.amount != null
      ? `${note.category === "income" ? "+" : note.category === "transfer" ? "⇄" : "-"}${formatAmount(note.amount, note.currency || "CNY")}`
      : "金额待定"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        note.amount == null || note.category === "transfer"
          ? "bg-muted text-muted-foreground"
          : note.category === "income"
            ? "bg-green-500/10 text-green-600 dark:text-green-400"
            : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
      )}
      title={merchant ? `商家/用途：${merchant}` : undefined}
    >
      {label}
      {merchant && <span className="max-w-24 truncate font-normal opacity-80">· {merchant}</span>}
    </span>
  )
}

function formatDue(due: string): string {
  const d = parseDue(due)
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const withYear =
    d.getFullYear() === new Date().getFullYear()
      ? date
      : `${d.getFullYear()}-${date}`
  return dueHasTime(due) ? `${withYear} ${pad(d.getHours())}:${pad(d.getMinutes())}` : withYear
}

const MAX_TAGS = 3
const CLAMP_THRESHOLD = 180
/** 未分拣笔记超过这个时长仍无分类时，从「分拣中」转为诚实的延迟提示（后端 cron 会自动补拣）。 */
const PENDING_LATE_MS = 10 * 60_000
/** 批量导入的笔记排队分拣属于正常积压（非故障），用更宽的阈值再报延迟。 */
const IMPORT_PENDING_LATE_MS = 60 * 60_000
const MAX_LINK_CARDS = 3
const MAX_EDIT_TAGS = 6

/** "YYYY-MM-DDTHH:mm" for <input type="datetime-local">, or "" when unset. */
function dueToInput(due: string | null): string {
  if (!due) return ""
  const d = parseDue(due)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local value -> offset ISO the API understands (local timezone). */
function inputToDue(v: string): string | null {
  if (!v) return null
  const offsetMin = -new Date(`${v}:00`).getTimezoneOffset()
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${v}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function linkCards(note: Note): { url: string; title: string | null }[] {
  if (Array.isArray(note.url_titles) && note.url_titles.length > 0)
    return note.url_titles.slice(0, MAX_LINK_CARDS)
  return note.url ? [{ url: note.url, title: note.url_title }] : []
}

/** Compact display form of a URL for title-less link cards: host + short path. */
function shortLink(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === "/" ? "" : u.pathname
    const s = `${u.hostname}${path}`
    return s.length > 40 ? `${s.slice(0, 40)}…` : s
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url
  }
}

const LINK_STATUS_TEXT: Record<string, string> = {
  fetch_failed: "未能抓取正文，已保存链接",
  no_content: "未能抓取正文，已保存链接",
}

/** 本地/内网地址服务端天然抓不到正文，属预期而非失败，文案要区分 */
function isPrivateHost(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return (
      h === "localhost" ||
      h.endsWith(".local") ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    )
  } catch {
    return false
  }
}

function linkStatusText(status: string, url: string): string {
  if (isPrivateHost(url)) return "本地/内网链接无法抓取正文，链接本身已保存"
  return LINK_STATUS_TEXT[status] ?? "未能抓取正文，已保存链接"
}

/** 编辑保存结果：乐观锁 409 时带回服务器最新副本，卡片保留用户输入供对照合并 */
export type EditResult = { conflict: Note } | void

interface NoteCardProps {
  note: Note
  onToggleTodo?: (note: Note) => void
  onTagClick?: (tag: string) => void
  onEdit?: (note: Note, patch: NotePatch) => EditResult | Promise<EditResult>
  onDelete?: (note: Note) => void
  onToggleSensitive?: (note: Note) => void
  categoryFilterActive?: boolean
  /** 多选模式：显示选择框并点击卡片切换选中 */
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (note: Note) => void
  /** 所属线索标题：提供时在卡片底部显示可点击的线索入口 */
  threadTitle?: string | null
  /** 无问号疑问句（meta.is_question）：提供时卡片展示「去问 AI」轻量入口 */
  onAskQuestion?: (content: string) => void
  className?: string
}

export function NoteCard({
  note: noteProp,
  onToggleTodo,
  onTagClick,
  onEdit,
  onDelete,
  onToggleSensitive,
  categoryFilterActive = false,
  selectable = false,
  selected = false,
  onSelectToggle,
  threadTitle,
  onAskQuestion,
  className,
}: NoteCardProps) {
  const [localNote, setLocalNote] = useState<Note | null>(null)
  const note = localNote && localNote.id === noteProp.id ? localNote : noteProp
  const sourceMeta = SOURCE_META[note.source] ?? SOURCE_META.web
  const SourceIcon = sourceMeta.icon
  const isLink = note.url != null
  const done = note.todo_done === 1
  const pending = note.category === null
  // 分拣正常几秒内完成；超过阈值说明 AI 侧出了问题，诚实告知而不是永久转圈。
  // 导入笔记保留原 created_at，延迟从实际入库时间（imported_at）起算
  // 批量导入的积压是排队而非故障（R147 P2-2：数百条橙色告警角标噪音），
  // 用更宽阈值 + 中性文案；普通笔记仍按原阈值诚实报延迟
  const imported = note.meta?.imported_at != null
  const pendingSince = note.meta?.imported_at ?? note.created_at
  const pendingLate =
    pending &&
    Date.now() - parseServerTime(pendingSince).getTime() > (imported ? IMPORT_PENDING_LATE_MS : PENDING_LATE_MS)
  const sensitive = note.is_sensitive === 1

  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(note.content)
  const [editError, setEditError] = useState<string | null>(null)
  const [editCategory, setEditCategory] = useState<NoteCategory | "">(note.category ?? "")
  const [editTags, setEditTags] = useState<string[]>(note.tags)
  const [editTagInput, setEditTagInput] = useState("")
  const [editDue, setEditDue] = useState("")
  const [saving, setSaving] = useState(false)
  const [conflictNote, setConflictNote] = useState<Note | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [metaOpen, setMetaOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [excerptOpen, setExcerptOpen] = useState(false)
  const [fileExcerptOpen, setFileExcerptOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [refetching, setRefetching] = useState(false)
  const [retryingMedia, setRetryingMedia] = useState(false)
  const [retryMediaError, setRetryMediaError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const fileMeta = note.raw_type === "file" && note.meta?.file_name ? note.meta : null
  // 附件原件（R144 P1-1）：取首个匹配类型的附件；遮缩态不渲染、不发媒体请求
  const imageAtt = note.raw_type === "image" ? note.attachments?.find(isImageAttachment) : undefined
  const audioAtt = note.raw_type === "voice" ? note.attachments?.find(isAudioAttachment) : undefined

  async function downloadFile() {
    if (downloading || !fileMeta?.file_name) return
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadNoteFile(note.id, fileMeta.file_name)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloading(false)
    }
  }

  async function retryLinkFetch() {
    if (refetching) return
    setRefetching(true)
    try {
      setLocalNote(await refetchLink(note.id))
    } catch {
      // keep the current failed state; the user can retry again
    } finally {
      setRefetching(false)
    }
  }

  const mediaFailed =
    (note.raw_type === "voice" && (note.meta?.media_status === "extract_failed" || note.content.startsWith("【语音】转写失败"))) ||
    (note.raw_type === "image" && (note.meta?.media_status === "extract_failed" || note.content.startsWith("【图片】文字提取失败"))) ||
    (note.raw_type === "file" && note.meta?.file_status === "extract_failed")

  async function retryMediaExtract() {
    if (retryingMedia) return
    setRetryingMedia(true)
    setRetryMediaError(null)
    try {
      setLocalNote(await retryMedia(note.id))
    } catch (e) {
      // keep the failed state visible; the user can retry again
      setRetryMediaError(e instanceof Error ? e.message : String(e))
    } finally {
      setRetryingMedia(false)
    }
  }

  const imageDescription =
    note.raw_type === "image" && note.meta?.image_description && note.meta.image_description !== note.content
      ? note.meta.image_description
      : null

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [menuOpen])

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(note.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable
    }
    setMenuOpen(false)
  }

  function handleDelete() {
    setMenuOpen(false)
    setConfirmDeleteOpen(true)
  }

  const extraTags = note.tags.length - MAX_TAGS
  const longContent = note.content.length > CLAMP_THRESHOLD
  // 标题与正文相同（含仅差末尾标点）时只展示一次，避免卡片重复（R182 P2-2）
  const bodySameAsTitle = titleEchoesContent(note.title, note.content)

  return (
    <Card
      className={cn(
        "group p-4 transition-shadow hover:shadow-md",
        selectable && "cursor-pointer select-none",
        selectable && selected && "border-primary ring-1 ring-primary",
        className,
      )}
      onClick={selectable ? () => onSelectToggle?.(note) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {selectable && (
            <Checkbox
              checked={selected}
              onCheckedChange={() => onSelectToggle?.(note)}
              onClick={(e) => e.stopPropagation()}
              aria-label={selected ? "取消选择" : "选择这条笔记"}
              className="mr-0.5 size-5 sm:size-4"
            />
          )}
          {pending ? (
            pendingLate ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
                title="AI 分拣暂时不可用，内容已安全保存，服务恢复后会自动补分拣"
              >
                <CircleAlert className="size-3" />
                分拣延迟，将自动重试
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {imported ? "排队分拣中…" : "AI 分拣中…"}
              </span>
            )
          ) : (
            <CategoryBadge category={note.category} active={categoryFilterActive} />
          )}
          {!pending && note.meta?.triage_failed && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400"
              title="AI 多次尝试仍无法自动分拣，已按兜底分类保存；手动改分类即可修正"
            >
              <CircleAlert className="size-3" />
              自动分拣失败
            </span>
          )}
          {sensitive && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-600 dark:text-orange-400">
              <ShieldAlert className="size-3" />
              敏感
            </span>
          )}
          {note.category === "todo" && <DueChip due={note.todo_due} />}
          {(note.category === "expense" || note.category === "income" || note.category === "transfer") && <AmountChip note={note} />}
          <RawTypeBadge rawType={note.raw_type} />
          {note.match === "semantic" && (
            <Badge variant="secondary" className="gap-1 text-xs text-muted-foreground" title="按语义相关召回，原文可能不含搜索词">
              <Sparkles className="size-3" />
              语义匹配
            </Badge>
          )}
          {/* 遮罩态不外显派生标签（R154 P2-3）：与标题/摘要同口径，揭示后才展示 */}
          {!(sensitive && !revealed) && (
            <>
              {note.tags.slice(0, MAX_TAGS).map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className={cn(onTagClick && "cursor-pointer hover:bg-accent")}
                  onClick={() => onTagClick?.(tag)}
                >
                  #{tag}
                </Badge>
              ))}
              {extraTags > 0 && (
                <Badge variant="secondary" className="text-muted-foreground">
                  +{extraTags}
                </Badge>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <span role="img" title={sourceMeta.label} aria-label={sourceMeta.label}>
            <SourceIcon className="size-3" />
          </span>
          <time>{formatTime(note.created_at)}</time>
          {(onEdit || onDelete) && (
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-label="更多操作"
                className="rounded p-1 text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                style={menuOpen ? { opacity: 1 } : undefined}
              >
                <MoreHorizontal className="size-4" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-7 z-30 w-32 rounded-lg border bg-popover p-1 shadow-md">
                  {onEdit && (
                    <button
                      onClick={() => {
                        setEditValue(note.content)
                        setEditCategory(note.category ?? "")
                        setEditTags(note.tags)
                        setEditTagInput("")
                        setEditDue(dueToInput(note.todo_due))
                        setConflictNote(null)
                        setEditing(true)
                        setMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <Pencil className="size-3.5" /> 编辑
                    </button>
                  )}
                  <button
                    onClick={() => void copyContent()}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? "已复制" : "复制内容"}
                  </button>
                  {onToggleSensitive && (
                    <button
                      onClick={() => {
                        setMenuOpen(false)
                        onToggleSensitive(note)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      {sensitive ? <ShieldOff className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
                      {sensitive ? "取消敏感标记" : "标记为敏感"}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      onClick={handleDelete}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="size-3.5" /> 删除
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {note.title && !editing && !(sensitive && !revealed) && (
        <p
          className={cn(
            "mt-2 text-[15px] font-medium leading-snug",
            done && "text-muted-foreground line-through",
          )}
        >
          {note.title}
        </p>
      )}

      <div className={cn("flex items-start gap-2", note.title ? "mt-1" : "mt-2")}>
        {note.category === "todo" && !editing && (
          <Checkbox
            checked={done}
            onCheckedChange={() => onToggleTodo?.(note)}
            aria-label={done ? "标记为未完成" : "标记为完成"}
            className="mt-0.5 size-5 sm:size-4"
          />
        )}
        {editing ? (
          <div className="min-w-0 flex-1 space-y-3">
            <Textarea
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value)
                if (editError && e.target.value.trim()) setEditError(null)
              }}
              className="min-h-[80px] text-sm"
              autoFocus
            />
            {editError && <p className="text-xs text-destructive">{editError}</p>}
            {conflictNote && (
              <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                <p className="font-medium text-amber-600 dark:text-amber-400">
                  这条笔记刚被更新（可能来自其他设备或后台自动整理），你的输入仍保留在上方编辑框，可对照最新版本合并后再保存
                </p>
                <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
                  最新版本：{conflictNote.content}
                </p>
                <button
                  onClick={() => {
                    setEditValue(conflictNote.content)
                    setEditCategory(conflictNote.category ?? "")
                    setEditTags(conflictNote.tags)
                    setEditDue(dueToInput(conflictNote.todo_due))
                    setConflictNote(null)
                  }}
                  className="font-medium text-primary hover:underline"
                >
                  放弃我的输入，改用最新版本
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-muted-foreground" htmlFor={`cat-${note.id}`}>
                分类
              </label>
              <select
                id={`cat-${note.id}`}
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value as NoteCategory | "")}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {!note.category && <option value="">待分拣</option>}
                {(Object.keys(CATEGORY_META) as NoteCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                ))}
              </select>
              {editCategory === "todo" && (
                <>
                  <label className="text-xs text-muted-foreground" htmlFor={`due-${note.id}`}>
                    期限
                  </label>
                  <input
                    id={`due-${note.id}`}
                    type="datetime-local"
                    value={editDue}
                    onChange={(e) => setEditDue(e.target.value)}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  />
                  {editDue && (
                    <button
                      onClick={() => setEditDue("")}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      清除期限
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {editTags.map((t) => (
                <Badge key={t} variant="secondary" className="gap-1">
                  #{t}
                  <button
                    onClick={() => setEditTags((ts) => ts.filter((x) => x !== t))}
                    aria-label={`移除标签 ${t}`}
                    className="rounded-full hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              {editTags.length < MAX_EDIT_TAGS && (
                <Input
                  value={editTagInput}
                  onChange={(e) => setEditTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      const t = editTagInput.trim().replace(/^#/, "")
                      if (t && !editTags.includes(t)) setEditTags((ts) => [...ts, t])
                      setEditTagInput("")
                    }
                  }}
                  placeholder="加标签…回车确认"
                  className="h-7 w-32 text-xs"
                />
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={saving}
                onClick={() => {
                  const v = editValue.trim()
                  if (!v) {
                    setEditError("内容不能为空，如需删除请用删除操作")
                    return
                  }
                  const patch: NotePatch = {}
                  if (v !== note.content) patch.content = v
                  if (editCategory && editCategory !== note.category) patch.category = editCategory
                  const tagsChanged =
                    editTags.length !== note.tags.length || editTags.some((t, i) => t !== note.tags[i])
                  if (tagsChanged) patch.tags = editTags
                  const due = inputToDue(editDue)
                  if ((editCategory || note.category) === "todo" && editDue !== dueToInput(note.todo_due))
                    patch.todo_due = due
                  if (Object.keys(patch).length === 0) {
                    setEditError(null)
                    setConflictNote(null)
                    setEditing(false)
                    return
                  }
                  setSaving(true)
                  void (async () => {
                    try {
                      const res = await onEdit?.(note, patch)
                      if (res && "conflict" in res) {
                        setConflictNote(res.conflict)
                        return
                      }
                      setEditError(null)
                      setConflictNote(null)
                      setEditing(false)
                    } finally {
                      setSaving(false)
                    }
                  })()
                }}
              >
                {saving ? "保存中…" : "保存"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setEditError(null)
                  setConflictNote(null)
                  setEditing(false)
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : sensitive && !revealed ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setRevealed(true)
            }}
            aria-label="敏感内容，点击查看"
            className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-2 rounded-lg text-left"
          >
            <span className="select-none text-sm leading-7 tracking-widest text-muted-foreground">
              ••••••••••••
            </span>
            <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-secondary px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <Eye className="size-3" /> 敏感内容，点击查看
            </span>
          </button>
        ) : isLink ? (
          <div className="min-w-0 flex-1 space-y-2">
            {/* 抓取失败/无正文时（R183 P2-4）不展示站点级标题与营销摘要，
                避免把死链包装成看似抓取成功的卡片 */}
            {linkCards(note).map((card, i) => (
              <div
                key={card.url}
                className="rounded-lg border bg-muted/40 transition-colors hover:bg-muted"
              >
                <a
                  href={card.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group/link flex min-h-[52px] flex-col justify-center p-3"
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium group-hover/link:text-primary">
                    <LinkIcon className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {i === 0 && note.meta?.link_status && note.meta.link_status !== "ok"
                        ? shortLink(card.url)
                        : (card.title ?? shortLink(card.url))}
                    </span>
                    {i === 0 &&
                      card.title &&
                      note.meta?.link_site &&
                      !card.title.startsWith(note.meta.link_site) && (
                      <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {note.meta.link_site}
                      </span>
                    )}
                  </div>
                  {i === 0 && note.url_summary && (!note.meta?.link_status || note.meta.link_status === "ok") && (
                    <p
                      className={cn(
                        "mt-1 text-xs leading-relaxed text-muted-foreground",
                        !summaryOpen && "line-clamp-2",
                      )}
                    >
                      {note.url_summary}
                    </p>
                  )}
                </a>
                {i === 0 && note.meta?.link_status && note.meta.link_status !== "ok" && (
                  <div className="flex items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
                    <CircleAlert className="size-3.5 shrink-0" />
                    <span>{linkStatusText(note.meta.link_status, card.url)}</span>
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        void retryLinkFetch()
                      }}
                      disabled={refetching}
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-60"
                    >
                      <RefreshCw className={cn("size-3", refetching && "animate-spin")} />
                      {refetching ? "重试中…" : "重试抓取"}
                    </button>
                  </div>
                )}
                {i === 0 && (!note.meta?.link_status || note.meta.link_status === "ok") && (note.url_summary || note.meta?.link_excerpt) && (
                  <div className="flex items-center gap-3 px-3 pb-2">
                    {note.url_summary && note.url_summary.length > 60 && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          setSummaryOpen((x) => !x)
                        }}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {summaryOpen ? "收起摘要" : "展开摘要"}
                      </button>
                    )}
                    {note.meta?.link_excerpt && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          setExcerptOpen((x) => !x)
                        }}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {excerptOpen ? "收起正文摘录" : "查看正文摘录"}
                      </button>
                    )}
                  </div>
                )}
                {i === 0 && excerptOpen && note.meta?.link_excerpt && (
                  <p className="mx-3 mb-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                    {note.meta.link_excerpt}
                  </p>
                )}
              </div>
            ))}
            {note.content !== note.url && (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                {note.content}
              </p>
            )}
            {sensitive && revealed && (
              <button
                onClick={() => setRevealed(false)}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <EyeOff className="size-3" /> 隐藏
              </button>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            {!bodySameAsTitle && (
              <p
                className={cn(
                  "whitespace-pre-wrap text-sm leading-relaxed",
                  done && "text-muted-foreground line-through",
                  longContent && !expanded && "line-clamp-6",
                )}
              >
                {note.content}
              </p>
            )}
            {longContent && (
              <button
                onClick={() => setExpanded((x) => !x)}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                {expanded ? "收起" : "展开全文"}
              </button>
            )}
            {imageAtt && <NoteImage noteId={note.id} attachment={imageAtt} alt={note.title || "笔记图片"} />}
            {audioAtt && <NoteAudio noteId={note.id} attachment={audioAtt} className="mt-2" />}
            {mediaFailed && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CircleAlert className="size-3.5 shrink-0" />
                <span>{note.raw_type === "voice" ? "转写失败，原件已存档" : note.raw_type === "image" ? "文字提取失败，原件已存档" : "文本提取失败，原件已存档"}</span>
                <button
                  onClick={() => void retryMediaExtract()}
                  disabled={retryingMedia}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-60"
                >
                  <RefreshCw className={cn("size-3", retryingMedia && "animate-spin")} />
                  {retryingMedia ? "重试中…" : "原地重试"}
                </button>
                {retryMediaError && <span className="w-full text-destructive">{retryMediaError}</span>}
              </div>
            )}
            {fileMeta && (
              <div className="mt-2 rounded-lg border bg-muted/40 p-2.5">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{fileMeta.file_name}</span>
                  {fileMeta.file_kind && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs uppercase text-muted-foreground">
                      {fileMeta.file_kind}
                    </span>
                  )}
                  <button
                    onClick={() => void downloadFile()}
                    disabled={downloading}
                    aria-label="下载原件"
                    title="下载原件"
                    className="-my-2 shrink-0 rounded-md p-3.5 text-muted-foreground hover:bg-accent hover:text-foreground md:-my-0.5 md:p-1.5"
                  >
                    {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  </button>
                </div>
                {downloadError && <p className="mt-1 text-xs text-destructive">{downloadError}</p>}
                {fileMeta.file_excerpt && (
                  <div className="mt-1.5">
                    <button
                      onClick={() => setFileExcerptOpen((x) => !x)}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {fileExcerptOpen ? "收起全文摘录" : "查看全文摘录"}
                    </button>
                    {fileExcerptOpen && (
                      <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                        {fileMeta.file_excerpt}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
            {imageDescription && (
              <div className="mt-2">
                <button
                  onClick={() => setMetaOpen((x) => !x)}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                >
                  {metaOpen ? "收起图片描述" : "查看图片描述"}
                </button>
                {metaOpen && (
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground">
                    {imageDescription}
                  </p>
                )}
              </div>
            )}
            {sensitive && revealed && (
              <button
                onClick={() => setRevealed(false)}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <EyeOff className="size-3" /> 隐藏
              </button>
            )}
          </div>
        )}
      </div>
      {onAskQuestion && note.meta?.is_question && !sensitive && !editing && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onAskQuestion(note.content)
          }}
          className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          title="把这条内容作为问题发给 AI 问答"
        >
          <Sparkles className="size-3 shrink-0" />
          这像是个问题，去问 AI
        </button>
      )}
      {note.thread_id && threadTitle && !editing && (
        <a
          href={`#/threads?id=${encodeURIComponent(note.thread_id)}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-2 inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={`查看线索：${threadTitle}`}
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{threadTitle}</span>
        </a>
      )}
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="删除这条碎念？"
        description="将移入「最近删除」，30 天内可恢复。"
        confirmLabel="删除"
        onConfirm={() => {
          setConfirmDeleteOpen(false)
          onDelete?.(note)
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </Card>
  )
}
