import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, SendHorizontal, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { NoteCard } from "@/components/note-card"
import { ask } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { AskHistoryMessage, Note } from "@/lib/types"

const STORAGE_KEY = "suinian-ask-chat-v1"
const HISTORY_MAX_MESSAGES = 6 // 最近 3 轮

export interface AskChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  /** 引用笔记，index 与回答中的 [n] 对应 */
  refs?: { index: number; note: Note }[]
  error?: boolean
}

function loadMessages(): AskChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as AskChatMessage[]) : []
  } catch {
    return []
  }
}

function saveMessages(messages: AskChatMessage[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-50)))
  } catch {
    // storage full / unavailable: chat still works in-memory
  }
}

/** 把回答中的 [n] 渲染为可点击引用，点击滚动到下方对应笔记卡片 */
function AnswerText({ msgId, content, refIndexes }: { msgId: string; content: string; refIndexes: Set<number> }) {
  const parts = content.split(/([[［]\d{1,2}[\]］])/g)
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {parts.map((part, i) => {
        const m = part.match(/^[[［](\d{1,2})[\]］]$/)
        const n = m ? parseInt(m[1], 10) : null
        if (n !== null && refIndexes.has(n)) {
          return (
            <button
              key={i}
              className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1 align-text-bottom text-xs font-medium text-primary hover:bg-primary/25"
              onClick={() => {
                const el = document.getElementById(`ask-ref-${msgId}-${n}`)
                el?.scrollIntoView({ behavior: "smooth", block: "center" })
                el?.classList.add("ring-2", "ring-primary")
                window.setTimeout(() => el?.classList.remove("ring-2", "ring-primary"), 1600)
              }}
              aria-label={`跳转到引用笔记 ${n}`}
            >
              {n}
            </button>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </p>
  )
}

export function AskChat({ onTagClick }: { onTagClick?: (tag: string) => void }) {
  const [messages, setMessages] = useState<AskChatMessage[]>(loadMessages)
  const [input, setInput] = useState("")
  const [asking, setAsking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    saveMessages(messages)
  }, [messages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [messages.length, asking])

  const history = useMemo<AskHistoryMessage[]>(
    () =>
      messages
        .filter((m) => !m.error)
        .slice(-HISTORY_MAX_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content })),
    [messages],
  )

  async function send() {
    const q = input.trim()
    if (!q || asking) return
    setInput("")
    setAsking(true)
    const userMsg: AskChatMessage = { id: crypto.randomUUID(), role: "user", content: q }
    setMessages((ms) => [...ms, userMsg])
    try {
      const res = await ask(q, history)
      const refs = (res.references ?? []).flatMap((r) => {
        const note = res.notes.find((n) => n.id === r.note_id)
        return note ? [{ index: r.index, note }] : []
      })
      setMessages((ms) => [
        ...ms,
        { id: crypto.randomUUID(), role: "assistant", content: res.answer, refs },
      ])
    } catch (e) {
      setMessages((ms) => [
        ...ms,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: e instanceof Error ? e.message : String(e),
          error: true,
        },
      ])
    } finally {
      setAsking(false)
    }
  }

  return (
    <Card className="flex flex-col gap-0 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-primary" /> 和笔记对话
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setMessages([])}
          >
            <Trash2 className="size-3.5" /> 清空对话
          </Button>
        )}
      </div>

      <div ref={listRef} className="max-h-[55vh] space-y-3 overflow-y-auto px-3 py-3 md:max-h-[420px]">
        {messages.length === 0 && !asking && (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            问问你的笔记，例如「我最近在想什么」「上次记的那个点子是什么」。
            <br />
            支持多轮追问，回答中的 [n] 可点击查看引用笔记。
          </p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div
                className={cn(
                  "max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm px-3.5 py-2",
                  m.error ? "bg-destructive/10" : "bg-accent/60",
                )}
              >
                {m.error ? (
                  <p className="text-sm text-destructive">{m.content}</p>
                ) : (
                  <AnswerText
                    msgId={m.id}
                    content={m.content}
                    refIndexes={new Set((m.refs ?? []).map((r) => r.index))}
                  />
                )}
                {(m.refs?.length ?? 0) > 0 && (
                  <div className="space-y-2 border-t border-border/60 pt-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      引用笔记（{m.refs!.length}）
                    </p>
                    {m.refs!.map((r) => (
                      <div
                        key={`${r.index}-${r.note.id}`}
                        id={`ask-ref-${m.id}-${r.index}`}
                        className="rounded-xl transition-shadow"
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-3 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                            {r.index}
                          </span>
                          <div className="min-w-0 flex-1">
                            <NoteCard note={r.note} onTagClick={onTagClick} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        {asking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-accent/60 px-3.5 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 正在思考…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2 border-t px-3 py-2.5">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={1}
          placeholder="继续追问，Enter 发送…"
          className="max-h-28 min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button size="icon" className="size-9 shrink-0" onClick={() => void send()} disabled={asking || !input.trim()} aria-label="发送">
          {asking ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </div>
    </Card>
  )
}
