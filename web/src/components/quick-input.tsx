import { useRef, useState } from "react"
import { Send, Loader2, ImagePlus } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { ApiError, createNote, ingestImage, MAX_MEDIA_BYTES } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Note } from "@/lib/types"

export const MAX_CONTENT_CHARS = 20_000
const COUNTER_THRESHOLD = 18_000

export function QuickInput({ onCreated }: { onCreated: (note: Note) => void }) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const length = value.length
  const overLimit = length > MAX_CONTENT_CHARS

  async function submit() {
    const content = value.trim()
    if (!content || saving || overLimit) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote({ source: "web", raw_type: "text", content })
      setValue("")
      onCreated(note)
    } catch (e) {
      if (e instanceof ApiError && e.status === 413) {
        setError(e.message || `内容过长：最多 ${MAX_CONTENT_CHARS} 字符，请拆成多条或精简后再发。`)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  async function uploadImage(file: File) {
    if (uploading) return
    if (!file.type.startsWith("image/")) {
      setError("只支持上传图片文件")
      return
    }
    if (file.size > MAX_MEDIA_BYTES) {
      setError(`图片过大：最多 ${MAX_MEDIA_BYTES / 1024 / 1024}MB`)
      return
    }
    setUploading(true)
    setError(null)
    try {
      const note = await ingestImage(file)
      onCreated(note)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"))
          const file = item?.getAsFile()
          if (file) {
            e.preventDefault()
            void uploadImage(file)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
        placeholder="记点什么… 回车即存（Shift+回车换行）"
        className="min-h-[52px] resize-none border-0 p-1 shadow-none focus-visible:ring-0"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          想法 / 待办 / 链接 / 资料 / 图片，AI 自动分拣
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadImage(file)
              e.target.value = ""
            }}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="上传图片，AI 提取文字"
            title="上传图片，AI 提取文字（也可直接粘贴）"
          >
            {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
          </Button>
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
            onClick={() => void submit()}
            disabled={!value.trim() || saving || overLimit}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Send />}
            记下
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
    </div>
  )
}
