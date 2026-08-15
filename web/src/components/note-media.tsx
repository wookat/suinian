import { useEffect, useState } from "react"
import { CircleAlert, Loader2, X } from "lucide-react"
import { fetchNoteMediaUrl } from "@/lib/api"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { NoteAttachment } from "@/lib/types"

/**
 * 附件原件渲染（R144 P1-1）：图片缩略图+点击大图、语音可播放。
 * 取件一律带 Bearer 走 /api/notes/:id/file（R2 私有，无公链）；
 * 敏感笔记由父组件在遮罩态直接不渲染本组件，媒体请求也不会发出。
 */

function useMediaUrl(noteId: string, attachmentId: string | undefined, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchNoteMediaUrl(noteId, attachmentId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [noteId, attachmentId, enabled])
  return { url, error }
}

export function isImageAttachment(a: NoteAttachment): boolean {
  return !!a.mime && a.mime.startsWith("image/")
}

export function isAudioAttachment(a: NoteAttachment): boolean {
  return !!a.mime && a.mime.startsWith("audio/")
}

export function NoteImage({
  noteId,
  attachment,
  alt,
}: {
  noteId: string
  attachment: NoteAttachment
  alt: string
}) {
  const demo = loadSettings().useMock
  const { url, error } = useMediaUrl(noteId, attachment.id, !demo)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (demo) return null
  if (error)
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 shrink-0" /> 原图加载失败，可稍后刷新重试
      </p>
    )
  if (!url)
    return (
      <div className="mt-2 flex h-32 w-44 items-center justify-center rounded-lg border bg-muted/40">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        aria-label="点击查看大图"
        title="点击查看大图"
        className="mt-2 block overflow-hidden rounded-lg border"
      >
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="max-h-56 max-w-full cursor-zoom-in object-contain transition-opacity hover:opacity-90"
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="图片大图"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(false)
          }}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
        >
          <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />
          <button
            onClick={() => setOpen(false)}
            aria-label="关闭大图"
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
    </>
  )
}

export function NoteAudio({
  noteId,
  attachment,
  className,
}: {
  noteId: string
  attachment: NoteAttachment
  className?: string
}) {
  const demo = loadSettings().useMock
  const { url, error } = useMediaUrl(noteId, attachment.id, !demo)
  if (demo) return null
  if (error)
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <CircleAlert className="size-3.5 shrink-0" /> 语音加载失败，可稍后刷新重试
      </p>
    )
  if (!url)
    return (
      <div className={cn("flex h-10 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-xs text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" /> 语音加载中…
      </div>
    )
  return (
    <audio
      controls
      preload="metadata"
      src={url}
      onClick={(e) => e.stopPropagation()}
      className={cn("h-10 w-full max-w-sm", className)}
    >
      <a href={url}>播放语音</a>
    </audio>
  )
}
