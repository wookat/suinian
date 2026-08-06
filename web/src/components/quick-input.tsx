import { useState } from "react"
import { Send, Loader2 } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { ApiError, createNote } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Note } from "@/lib/types"

export const MAX_CONTENT_CHARS = 20_000
const COUNTER_THRESHOLD = 18_000

export function QuickInput({ onCreated }: { onCreated: (note: Note) => void }) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
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
          想法 / 待办 / 链接 / 资料，AI 自动分拣
        </span>
        <div className="flex shrink-0 items-center gap-2">
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
