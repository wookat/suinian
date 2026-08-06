import { useState } from "react"
import { Send, Loader2 } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { createNote } from "@/lib/api"
import type { Note } from "@/lib/types"

export function QuickInput({ onCreated }: { onCreated: (note: Note) => void }) {
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const content = value.trim()
    if (!content || saving) return
    setSaving(true)
    setError(null)
    try {
      const note = await createNote({ source: "web", raw_type: "text", content })
      setValue("")
      onCreated(note)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          想法 / 待办 / 链接 / 资料，AI 自动分拣
        </span>
        <Button size="sm" onClick={() => void submit()} disabled={!value.trim() || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Send />}
          记下
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
