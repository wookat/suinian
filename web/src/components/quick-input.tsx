import { useEffect, useMemo, useRef, useState } from "react"
import { Send, Loader2, Paperclip, Sparkles, Lock, Tag, CloudOff, ChevronDown, ChevronUp, RefreshCw } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { ApiError, NetworkError, createNote, ingestMedia, MAX_MEDIA_BYTES, mediaTooLargeText, SUPPORTED_FILE_EXTS } from "@/lib/api"
import { enqueueMedia, enqueueNote, flushOutbox, onOutboxCount, onOutboxDropped, onOutboxFlushed, outboxPreviews, startOutboxAutoFlush } from "@/lib/outbox"
import type { OutboxPreview } from "@/lib/outbox"
import { VoiceRecorder, voiceSupported } from "@/components/voice-recorder"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { Note } from "@/lib/types"

export const MAX_CONTENT_CHARS = 20_000
const COUNTER_THRESHOLD = 18_000

/** 未提交输入的本地草稿：离线/刷新不丢字，提交成功即清 */
const DRAFT_KEY = "suinian.quick_input_draft"

function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

function saveDraft(value: string) {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value)
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // 存储不可用（隐私模式配额等）时静默降级，不影响输入
  }
}

/** 内联指令（与帮助文案/微信指令对齐）：?问题 提问；!内容 原样保存；#标签 内容 手动打标 */
export type InlineCommand =
  | { kind: "ask"; question: string }
  | { kind: "raw"; content: string }
  | { kind: "tags"; tags: string[]; content: string }
  | null

export function parseInlineCommand(value: string): InlineCommand {
  const v = value.trimStart()
  if (v.startsWith("?") || v.startsWith("？")) return { kind: "ask", question: v.slice(1).trim() }
  if (v.startsWith("!") || v.startsWith("！")) return { kind: "raw", content: v.slice(1).trim() }
  if (v.startsWith("#")) {
    const m = v.match(/^((?:#[^\s#＃]+[ \t]*)+)([\s\S]*)$/)
    if (!m) return null
    const tags = (m[1].match(/#[^\s#＃]+/g) ?? []).map((t) => t.slice(1)).slice(0, 6)
    const content = m[2].trim()
    if (tags.length === 0) return null
    return { kind: "tags", tags, content }
  }
  return null
}

export function QuickInput({ onCreated, onAsk }: { onCreated: (note: Note) => void; onAsk?: (question: string) => void }) {
  const [value, setValue] = useState(loadDraft)
  // 并发保存计数：输入框提交后立即清空，保存在后台进行，连发多条互不阻塞
  const [savingCount, setSavingCount] = useState(0)
  const saving = savingCount > 0
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingSync, setPendingSync] = useState(0)
  // R206 P3-3：横幅可展开查看排队中的具体内容，不再只有一个计数
  const [queueOpen, setQueueOpen] = useState(false)
  const [queueItems, setQueueItems] = useState<OutboxPreview[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    saveDraft(value)
  }, [value])

  // 离线队列（R122 P1-3）：启动时重放存量 + 监听 online 自动重放；
  // 重放成功的笔记和待同步条数都回到本组件展示
  useEffect(() => {
    startOutboxAutoFlush()
    const offCount = onOutboxCount(setPendingSync)
    const offFlushed = onOutboxFlushed(onCreated)
    // R302 P0-4：补发被服务端永久拒绝的条目不静默丢——内容退回输入框并提示。
    const offDropped = onOutboxDropped((label, reason) => {
      setValue((v) => (v.trim() ? `${label}\n${v}` : label))
      setError(`有 1 条离线记录补发被拒（${reason}），内容已退回输入框。`)
    })
    return () => {
      offCount()
      offFlushed()
      offDropped()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 补发/新入队时刷新展开中的预览；清零后收起
  useEffect(() => {
    if (pendingSync === 0) setQueueOpen(false)
    else if (queueOpen) void outboxPreviews().then(setQueueItems).catch(() => {})
  }, [pendingSync, queueOpen])

  const length = value.length
  const overLimit = length > MAX_CONTENT_CHARS
  const command = useMemo(() => parseInlineCommand(value), [value])
  // 以问号结尾的疑问句（R159 D-3）：?前缀指令很难被发现，疑问句直接回车会
  // 存成笔记（往往分拣成 todo）。给一个可点的内联提示，不改变回车行为
  const questionLike = !command && /[？?]\s*$/.test(value) && value.trim().length > 1

  async function submit() {
    const content = value.trim()
    if (!content || overLimit) return
    const cmd = parseInlineCommand(content)
    if (cmd?.kind === "ask") {
      if (!cmd.question) return
      setValue("")
      setError(null)
      onAsk?.(cmd.question)
      return
    }
    if ((cmd?.kind === "raw" || cmd?.kind === "tags") && !cmd.content) return
    // 立即清空输入框再后台保存：快速连发时，新输入的内容绝不会被上一条保存完成后的清空操作吞掉
    setValue("")
    setError(null)
    setSavingCount((n) => n + 1)
    const payload =
      cmd?.kind === "raw"
        ? { source: "web" as const, raw_type: "text" as const, content: cmd.content, skip_triage: true }
        : cmd?.kind === "tags" && cmd.content
          ? { source: "web" as const, raw_type: "text" as const, content: cmd.content, tags: cmd.tags }
          : { source: "web" as const, raw_type: "text" as const, content }
    try {
      // R302 P0-4：已知离线时不先打网络再等失败——直接入队（入队失败才回退
      // 到网络尝试），确保断网速记确实落进 IndexedDB。
      if (!navigator.onLine && !loadSettings().useMock) {
        if (await enqueueNote(payload)) {
          setError(null)
          return
        }
      }
      const note = await createNote(payload)
      onCreated(note)
    } catch (e) {
      // 网络失败（离线/超时）与服务端瞬时故障（429/5xx）：进 IndexedDB 离线
      // 队列，联网后自动补发；入队失败才退回输入框兕底
      const transient =
        e instanceof NetworkError ||
        (e instanceof ApiError && (e.status === 429 || e.status >= 500)) ||
        !navigator.onLine
      if (transient && !loadSettings().useMock) {
        if (await enqueueNote(payload)) {
          setError(null)
          return
        }
      }
      // 保存失败：把内容退回输入框，不丢一个字
      setValue((v) => (v.trim() ? `${content}\n${v}` : content))
      if (e instanceof ApiError && e.status === 413) {
        setError(e.message || `内容过长：最多 ${MAX_CONTENT_CHARS} 字符，请拆成多条或精简后再发。`)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSavingCount((n) => n - 1)
    }
  }

  async function uploadMedia(file: File) {
    if (uploading) return
    const isImage = file.type.startsWith("image/")
    const ext = file.name.split(".").pop()?.toLowerCase() ?? ""
    if (!isImage && !SUPPORTED_FILE_EXTS.includes(ext)) {
      setError("只支持图片或 PDF / txt / md / docx / csv / xlsx 文件")
      return
    }
    if (file.size > MAX_MEDIA_BYTES) {
      setError(mediaTooLargeText("文件", file.size))
      return
    }
    setUploading(true)
    setError(null)
    try {
      const note = await ingestMedia(file, isImage ? "image" : "file")
      onCreated(note)
    } catch (e) {
      // 离线/网络失败：图片与文件同文本/语音一样进 IndexedDB 离线队列，
      // 联网后自动补传，不再失败即丢
      if ((e instanceof NetworkError || !navigator.onLine) && !loadSettings().useMock) {
        if (await enqueueMedia(file, isImage ? "image" : "file", file.name)) return
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  async function uploadVoice(file: File) {
    if (file.size > MAX_MEDIA_BYTES) {
      setError(mediaTooLargeText("录音", file.size))
      return
    }
    setUploading(true)
    setError(null)
    try {
      const note = await ingestMedia(file, "audio")
      onCreated(note)
    } catch (e) {
      // 离线/网络失败：录音进 IndexedDB 离线队列，联网后自动补传转写
      if ((e instanceof NetworkError || !navigator.onLine) && !loadSettings().useMock) {
        if (await enqueueMedia(file, "audio", file.name)) return
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      className="rounded-xl border bg-card p-3 shadow-sm"
      onClick={(e) => {
        // clicks on the card's padding land in the textarea, so the first
        // keystrokes never get swallowed by a missed tap on mobile
        if (e.target === e.currentTarget) textareaRef.current?.focus()
      }}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"))
          const file = item?.getAsFile()
          if (file) {
            e.preventDefault()
            void uploadMedia(file)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        aria-label="快速记录"
        placeholder={
          command?.kind === "ask"
            ? "问答模式：回车直接向你的笔记提问"
            : "记点什么… 回车即存（Shift+回车换行）"
        }
        className="min-h-[52px] resize-none border-0 p-1 shadow-none focus-visible:ring-0"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        {command?.kind === "ask" ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs font-medium text-primary">
            <Sparkles className="size-3.5 shrink-0" /> 问答模式：回车直接提问，不会存为笔记
          </span>
        ) : command?.kind === "raw" ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs font-medium text-primary">
            <Lock className="size-3.5 shrink-0" /> 原样保存：不经 AI 分拣，存为「想法」
          </span>
        ) : command?.kind === "tags" ? (
          <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs font-medium text-primary">
            <Tag className="size-3.5 shrink-0" /> 手动打标：{command.tags.map((t) => `#${t}`).join(" ")}
          </span>
        ) : questionLike ? (
          <button
            onClick={() => setValue((v) => `?${v.trimStart()}`)}
            className="inline-flex min-w-0 items-center gap-1 truncate text-xs font-medium text-primary hover:underline"
            title="加上 ? 前缀切换到问答模式；不点的话回车仍会存为笔记"
          >
            <Sparkles className="size-3.5 shrink-0" /> 像是在提问？点此改为向笔记提问（回车仍会存为笔记）
          </button>
        ) : (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            想法 / 待办 / 链接 / 图片 / 文件，AI 自动分拣；?提问 !原样存 #打标
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.markdown,.docx,.csv,.tsv,.xlsx"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadMedia(file)
              e.target.value = ""
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-11 min-w-11 sm:h-8 sm:min-w-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="上传图片或文件，AI 提取内容"
            title="上传图片或文件（PDF/txt/md/docx），AI 提取内容"
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
          </Button>
          {voiceSupported() && (
            <VoiceRecorder onRecorded={(f) => void uploadVoice(f)} onError={setError} disabled={uploading} />
          )}
          {length >= COUNTER_THRESHOLD && (
            <span
              className={cn(
                "text-xs tabular-nums",
                overLimit ? "font-medium text-destructive" : "text-muted-foreground",
              )}
            >
              {length.toLocaleString()} / {MAX_CONTENT_CHARS.toLocaleString()}
            </span>
          )}
          <Button
            size="sm"
            className="h-11 min-w-[72px] sm:h-8 sm:min-w-0"
            onClick={() => void submit()}
            disabled={
              !value.trim() ||
              overLimit ||
              (command?.kind === "ask" && !command.question) ||
              (command?.kind === "raw" && !command.content) ||
              (command?.kind === "tags" && !command.content)
            }
          >
            {saving ? <Loader2 className="animate-spin" /> : command?.kind === "ask" ? <Sparkles /> : <Send />}
            {command?.kind === "ask" ? "提问" : "记下"}
          </Button>
        </div>
      </div>
      {overLimit && (
        <p className="mt-1 text-xs text-destructive">
          内容过长：最多 {MAX_CONTENT_CHARS.toLocaleString()} 字符，当前{" "}
          {length.toLocaleString()} 字符。请拆成多条或精简后再发。
        </p>
      )}
      {error && !overLimit && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {pendingSync > 0 && (
        <div className="mt-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const next = !queueOpen
                setQueueOpen(next)
                if (next) void outboxPreviews().then(setQueueItems).catch(() => setQueueItems([]))
              }}
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              title="展开查看排队中的内容"
            >
              <CloudOff className="size-3.5" /> {pendingSync} 条离线记录（含图片/文件/录音）待同步，联网后自动补发
              {queueOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
            <button
              onClick={() => void flushOutbox()}
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <RefreshCw className="size-3" /> 立即重试
            </button>
          </div>
          {queueOpen && queueItems.length > 0 && (
            <ul className="mt-1 space-y-0.5 rounded-md border bg-muted/40 px-2 py-1.5">
              {queueItems.map((it, i) => (
                <li key={i} className="truncate" title={it.label}>
                  • {it.label.length > 60 ? `${it.label.slice(0, 60)}…` : it.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
