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
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  CalendarClock,
  Loader2,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn, formatTime } from "@/lib/utils"
import type { Note, NoteCategory } from "@/lib/types"

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
}

const SOURCE_ICON = {
  wechat: MessageCircle,
  android: Smartphone,
  web: Globe,
  api: Globe,
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
  const overdue = new Date(due).getTime() < Date.now()
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        overdue
          ? "bg-red-500/10 text-red-600 dark:text-red-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      <CalendarClock className="size-3" />
      {overdue ? "已过期 " : ""}
      {formatDue(due)}
    </span>
  )
}

function formatDue(due: string): string {
  const d = new Date(due)
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const withYear =
    d.getFullYear() === new Date().getFullYear()
      ? date
      : `${d.getFullYear()}-${date}`
  const hasTime = /[T ]\d{2}:\d{2}/.test(due)
  return hasTime ? `${withYear} ${pad(d.getHours())}:${pad(d.getMinutes())}` : withYear
}

const MAX_TAGS = 3
const CLAMP_THRESHOLD = 180
const MAX_LINK_CARDS = 3

function linkCards(note: Note): { url: string; title: string | null }[] {
  if (Array.isArray(note.url_titles) && note.url_titles.length > 0)
    return note.url_titles.slice(0, MAX_LINK_CARDS)
  return note.url ? [{ url: note.url, title: note.url_title }] : []
}

interface NoteCardProps {
  note: Note
  onToggleTodo?: (note: Note) => void
  onTagClick?: (tag: string) => void
  onEdit?: (note: Note, content: string) => void
  onDelete?: (note: Note) => void
  categoryFilterActive?: boolean
}

export function NoteCard({
  note,
  onToggleTodo,
  onTagClick,
  onEdit,
  onDelete,
  categoryFilterActive = false,
}: NoteCardProps) {
  const SourceIcon = SOURCE_ICON[note.source] ?? Globe
  const isLink = note.url != null
  const done = note.todo_done === 1
  const pending = note.category === null
  const sensitive = note.is_sensitive === 1

  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(note.content)
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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
    if (window.confirm("确定删除这条碎念吗？删除后无法恢复。")) onDelete?.(note)
  }

  const extraTags = note.tags.length - MAX_TAGS
  const longContent = note.content.length > CLAMP_THRESHOLD

  return (
    <Card className="group p-4 transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {pending ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              AI 分拣中…
            </span>
          ) : (
            <CategoryBadge category={note.category} active={categoryFilterActive} />
          )}
          {note.category === "todo" && <DueChip due={note.todo_due} />}
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
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <SourceIcon className="size-3" />
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

      {note.title && !editing && (
        <h3
          className={cn(
            "mt-2 text-[15px] font-medium leading-snug",
            done && "text-muted-foreground line-through",
          )}
        >
          {note.title}
        </h3>
      )}

      <div className={cn("flex items-start gap-2", note.title ? "mt-1" : "mt-2")}>
        {note.category === "todo" && !editing && (
          <input
            type="checkbox"
            checked={done}
            onChange={() => onToggleTodo?.(note)}
            aria-label={done ? "标记为未完成" : "标记为完成"}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
          />
        )}
        {editing ? (
          <div className="min-w-0 flex-1 space-y-2">
            <Textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="min-h-[80px] text-sm"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const v = editValue.trim()
                  if (v && v !== note.content) onEdit?.(note, v)
                  setEditing(false)
                }}
              >
                保存
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : sensitive && !revealed ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <p className="select-none text-sm tracking-widest text-muted-foreground">
              ••••••••••••
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              onClick={() => setRevealed(true)}
            >
              <Eye className="size-3.5" /> 显示
            </Button>
          </div>
        ) : isLink ? (
          <div className="min-w-0 flex-1 space-y-2">
            {linkCards(note).map((card, i) => (
              <a
                key={card.url}
                href={card.url}
                target="_blank"
                rel="noreferrer"
                className="group/link block rounded-lg border bg-muted/40 p-3 transition-colors hover:bg-muted"
              >
                <div className="flex items-center gap-1.5 text-sm font-medium group-hover/link:text-primary">
                  <LinkIcon className="size-3.5 shrink-0" />
                  <span className="truncate">{card.title ?? card.url}</span>
                </div>
                {i === 0 && note.url_summary && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {note.url_summary}
                  </p>
                )}
              </a>
            ))}
            {note.content !== note.url && (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                {note.content}
              </p>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "whitespace-pre-wrap text-sm leading-relaxed",
                done && "text-muted-foreground line-through",
                longContent && !expanded && "line-clamp-6",
              )}
            >
              {note.content}
            </p>
            {longContent && (
              <button
                onClick={() => setExpanded((x) => !x)}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                {expanded ? "收起" : "展开全文"}
              </button>
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
    </Card>
  )
}
