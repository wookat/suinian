import {
  Lightbulb,
  CheckSquare,
  Bookmark,
  Database,
  Link as LinkIcon,
  MessageCircle,
  Smartphone,
  Globe,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn, formatTime } from "@/lib/utils"
import type { Note, NoteCategory } from "@/lib/types"

const CATEGORY_META: Record<
  NoteCategory,
  { label: string; icon: typeof Lightbulb; className: string }
> = {
  idea: {
    label: "想法",
    icon: Lightbulb,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  todo: {
    label: "待办",
    icon: CheckSquare,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  collect: {
    label: "收藏",
    icon: Bookmark,
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  data: {
    label: "资料",
    icon: Database,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
}

const SOURCE_ICON = {
  wechat: MessageCircle,
  android: Smartphone,
  web: Globe,
  api: Globe,
} as const

export function CategoryBadge({ category }: { category: NoteCategory | null }) {
  if (!category) return null
  const meta = CATEGORY_META[category]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

interface NoteCardProps {
  note: Note
  onToggleTodo?: (note: Note) => void
  onTagClick?: (tag: string) => void
}

export function NoteCard({ note, onToggleTodo, onTagClick }: NoteCardProps) {
  const SourceIcon = SOURCE_ICON[note.source] ?? Globe
  const isLink = note.raw_type === "link" && note.url
  const done = note.todo_done === 1

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <CategoryBadge category={note.category} />
          {note.tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className={cn(onTagClick && "cursor-pointer hover:bg-accent")}
              onClick={() => onTagClick?.(tag)}
            >
              #{tag}
            </Badge>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <SourceIcon className="size-3" />
          <time>{formatTime(note.created_at)}</time>
        </div>
      </div>

      <div className="mt-2 flex items-start gap-2">
        {note.category === "todo" && (
          <input
            type="checkbox"
            checked={done}
            onChange={() => onToggleTodo?.(note)}
            aria-label={done ? "标记为未完成" : "标记为完成"}
            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
          />
        )}
        {isLink ? (
          <div className="min-w-0 flex-1">
            <a
              href={note.url!}
              target="_blank"
              rel="noreferrer"
              className="group block rounded-lg border bg-muted/40 p-3 transition-colors hover:bg-muted"
            >
              <div className="flex items-center gap-1.5 text-sm font-medium group-hover:text-primary">
                <LinkIcon className="size-3.5 shrink-0" />
                <span className="truncate">{note.url_title ?? note.url}</span>
              </div>
              {note.url_summary && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {note.url_summary}
                </p>
              )}
            </a>
            {note.content !== note.url && (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                {note.content}
              </p>
            )}
          </div>
        ) : (
          <p
            className={cn(
              "min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed",
              done && "text-muted-foreground line-through",
            )}
          >
            {note.content}
          </p>
        )}
      </div>
    </Card>
  )
}
