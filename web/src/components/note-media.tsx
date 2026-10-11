import { useCallback, useEffect, useState, type ReactNode } from "react"
import { CircleAlert, Download, Loader2, RefreshCw, Share2 } from "lucide-react"
import { ImageLightbox } from "@/components/image-lightbox"
import { fetchNoteMediaUrl } from "@/lib/api"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { NoteAttachment } from "@/lib/types"
import { audioFormatLabel, browserCanPlayAudio, unplayableAudioText } from "@/lib/audio-support"
import { mediaLoadFailureAutoRetries, mediaLoadFailureText } from "@/lib/media-failure"
import { attachmentDownloadName } from "@/lib/attachment-name"
import { shareFile, useShareFile } from "@/lib/use-share-file"

/**
 * 附件原件渲染（R144 P1-1）：图片缩略图+点击大图、语音可播放。
 * 取件一律带 Bearer 走 /api/notes/:id/file（R2 私有，无公链）；
 * 敏感笔记由父组件在遮罩态直接不渲染本组件，媒体请求也不会发出。
 */

/**
 * 卡片是按笔记 id 作 key 的列表项：列表重拉只换 Note 对象、本 hook 状态保留，所以失败态必须能在原地重试——
 * 点击失败行重拉；连接级失败 / 服务端 5xx 在浏览器联网、页面回到前台时自动重拉一次（404 / 401 重拉也不会变，不自动）。
 */
function useMediaUrl(noteId: string, attachmentId: string | undefined, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchNoteMediaUrl(noteId, attachmentId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e ?? new Error("media load failed"))
      })
    return () => {
      cancelled = true
    }
  }, [noteId, attachmentId, enabled, attempt])

  const retry = useCallback(() => {
    setError(null)
    setAttempt((n) => n + 1)
  }, [])

  const autoRetry = error !== null && mediaLoadFailureAutoRetries(error)
  useEffect(() => {
    if (!autoRetry) return
    const onOnline = () => retry()
    const onVisible = () => {
      if (document.visibilityState === "visible") retry()
    }
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [autoRetry, retry])

  return { url, error, failureText: error === null ? null : mediaLoadFailureText(error), attempt, retry }
}

/** 附件加载失败行：整行是重试按钮，第二行给可读原因（有的话） */
function MediaLoadFailed({
  label,
  reason,
  onRetry,
  className,
}: {
  label: string
  reason: string | null
  onRetry: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onRetry()
      }}
      className={cn(
        "flex items-start gap-1.5 rounded-md text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex flex-col">
        <span>{label}，点击重试</span>
        {reason && <span className="text-[11px] opacity-80">{reason}</span>}
      </span>
    </button>
  )
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
  const { url, error, failureText, retry } = useMediaUrl(noteId, attachment.id, !demo)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  if (demo) return null
  if (error !== null) return <MediaLoadFailed label="原图加载失败" reason={failureText} onRetry={retry} className="mt-2" />
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
      {open && <ImageLightbox src={url} alt={alt} downloadName={attachment.name} mime={attachment.mime} onClose={close} />}
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
  const { url, error, failureText, attempt, retry } = useMediaUrl(noteId, attachment.id, !demo)
  const [unplayable, setUnplayable] = useState(() => !browserCanPlayAudio(attachment.mime))
  const [elementFailed, setElementFailed] = useState(false)
  const downloadName = attachmentDownloadName(attachment.name, attachment.mime, `voice-${noteId.slice(0, 8)}`)
  const shareable = useShareFile(demo ? null : url, downloadName, attachment.mime)
  if (demo) return null
  if (error !== null || elementFailed)
    return (
      <MediaLoadFailed
        label="语音加载失败"
        reason={error !== null ? failureText : "浏览器读取语音数据失败"}
        onRetry={() => {
          setElementFailed(false)
          retry()
        }}
        className={className}
      />
    )
  if (!url)
    return (
      <div className={cn("flex h-10 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-xs text-muted-foreground", className)}>
        <Loader2 className="size-3.5 animate-spin" /> 语音加载中…
      </div>
    )
  if (unplayable) {
    const format = audioFormatLabel(attachment)
    return (
      <div
        role="note"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
          className,
        )}
      >
        <CircleAlert className="size-3.5 shrink-0" />
        <span>{unplayableAudioText(format)}</span>
        <a
          href={url}
          download={downloadName}
          className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:opacity-80"
        >
          <Download className="size-3.5" /> 下载原件
        </a>
        {shareable && (
          <button
            type="button"
            onClick={() => shareFile(shareable, "分享语音")}
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:opacity-80"
          >
            <Share2 className="size-3.5" /> 分享
          </button>
        )}
      </div>
    )
  }
  return (
    <div className={cn("flex w-full max-w-md items-center gap-1", className)} onClick={(e) => e.stopPropagation()}>
      <audio
        key={attempt}
        controls
        controlsList="nodownload"
        preload="metadata"
        src={url}
        onError={(e) => {
          const code = e.currentTarget.error?.code
          // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED：格式不受支持（canPlayType 答 maybe 但解封装失败）；其余是加载问题
          if (code === 3 || code === 4) setUnplayable(true)
          else setElementFailed(true)
        }}
        className="h-10 min-w-0 flex-1"
      >
        <a href={url}>播放语音</a>
      </audio>
      {shareable && (
        <AudioExportButton label="分享语音" onClick={() => shareFile(shareable, "分享语音")}>
          <Share2 className="size-4" />
        </AudioExportButton>
      )}
      <AudioExportButton label="下载原件" href={url} download={downloadName}>
        <Download className="size-4" />
      </AudioExportButton>
    </div>
  )
}

const exportButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function AudioExportButton({
  label,
  href,
  download,
  onClick,
  children,
}: {
  label: string
  href?: string
  download?: string
  onClick?: () => void
  children: ReactNode
}) {
  if (href !== undefined)
    return (
      <a href={href} download={download} aria-label={label} title={label} className={exportButtonClass}>
        {children}
      </a>
    )
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={exportButtonClass}>
      {children}
    </button>
  )
}
