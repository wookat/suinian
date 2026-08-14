import { useEffect, useMemo, useRef, useState } from "react"
import { BookmarkPlus, Check, CircleHelp, Loader2, SendHorizontal, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { NoteCard } from "@/components/note-card"
import { ask, createNote } from "@/lib/api"
import { loadSettings, useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { AskHistoryMessage, Note } from "@/lib/types"

const LEGACY_STORAGE_KEY = "suinian-ask-chat-v1" // 旧版全局共享 key，会跨账号泄露，读到即删
const STORAGE_PREFIX = "suinian-ask-chat-v2:"
const HISTORY_MAX_MESSAGES = 6 // 最近 3 轮

/** 问答历史按账号隔离：key 携带当前 API 地址 + token 的指纹 */
function storageKey(): string {
  const s = loadSettings()
  if (s.useMock || !s.apiToken) return `${STORAGE_PREFIX}anon`
  const str = `${s.apiBaseUrl}|${s.apiToken}`
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${STORAGE_PREFIX}${(h >>> 0).toString(36)}`
}

export const HELP_TEXT = [
  "碎念能帮你：",
  "• 随手记：首页输入框/微信 bot 丢文字、链接、语音、图片、文件，AI 自动分拣为想法/待办/收藏/资料",
  "• 问答：在这里直接提问，如「我最近在想什么」，支持多轮追问，回答中 [n] 可点击查看引用笔记",
  "• 快捷指令（微信 & 首页速记框）：?问题 提问；!内容 强制原样保存不分拣；#标签 内容 手动打标",
  "• 回顾：每天推送往日笔记回顾；每周一生成周报；同主题想法自动串成线索",
  "• 数据：设置页可导入 flomo/Cubox、导出 JSON/Markdown，也可用 API 直接写入",
].join("\n")

export interface AskChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  /** 引用笔记，index 与回答中的 [n] 对应 */
  refs?: { index: number; note: Note }[]
  /** 本轮回答对应的问题（存为笔记用） */
  question?: string
  error?: boolean
}

/** 把一轮问答（问题 + 回答 + 引用链接）拼成一条可保存的笔记正文 */
export function buildAskNoteContent(question: string, answer: string, refs: { index: number; note: Note }[]): string {
  const lines = [`问：${question}`, "", `答：${answer}`]
  if (refs.length > 0) {
    lines.push("", "引用：")
    for (const r of refs) {
      const label =
        r.note.is_sensitive === 1
          ? "敏感内容"
          : (r.note.title || r.note.content).replace(/\s+/g, " ").slice(0, 60)
      const link = r.note.url || (r.note.thread_id ? `${location.origin}${location.pathname}#/threads?id=${r.note.thread_id}` : "")
      lines.push(`[${r.index}] ${label}${link ? ` ${link}` : ""}`)
    }
  }
  return lines.join("\n")
}

function loadMessages(): AskChatMessage[] {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    const raw = localStorage.getItem(storageKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as AskChatMessage[]) : []
  } catch {
    return []
  }
}

function saveMessages(messages: AskChatMessage[]) {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(messages.slice(-50)))
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

export function AskChat({
  onTagClick,
  initialQuestion,
  onInitialQuestionConsumed,
  initialInput,
  onInitialInputConsumed,
}: {
  onTagClick?: (tag: string) => void
  /** 首页速记框 `?问题` 内联指令带过来的问题，挂载/变化时自动发送 */
  initialQuestion?: string | null
  onInitialQuestionConsumed?: () => void
  /** 预填到输入框但不自动发送（搜索空态「用 AI 问问看」：由用户确认后再消耗 AI 调用） */
  initialInput?: string | null
  onInitialInputConsumed?: () => void
}) {
  const [messages, setMessages] = useState<AskChatMessage[]>(loadMessages)
  const [input, setInput] = useState("")
  const [asking, setAsking] = useState(false)
  const [saveStates, setSaveStates] = useState<Record<string, "saving" | "saved" | "error">>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 账号切换（token 变化）时切到对应账号的历史，绝不把上个账号的对话带过去
  const settingsVersion = useSettingsVersion()
  const keyRef = useRef(storageKey())
  useEffect(() => {
    const k = storageKey()
    if (k !== keyRef.current) {
      keyRef.current = k
      setMessages(loadMessages())
    }
  }, [settingsVersion])

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

  function showHelp() {
    setMessages((ms) => [
      ...ms,
      { id: crypto.randomUUID(), role: "assistant", content: HELP_TEXT },
    ])
  }

  async function send(question?: string) {
    const q = (question ?? input).trim()
    if (!q || asking) return
    if (question === undefined) setInput("")
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
        { id: crypto.randomUUID(), role: "assistant", content: res.answer, refs, question: q },
      ])
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const friendly = /internal error|^5\d\d$|failed to fetch/i.test(raw) ? "问答服务暂时不可用，请稍后重试" : raw
      setMessages((ms) => [
        ...ms,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: friendly,
          question: q,
          error: true,
        },
      ])
    } finally {
      setAsking(false)
    }
  }

  async function saveAsNote(m: AskChatMessage) {
    if (saveStates[m.id] === "saving" || saveStates[m.id] === "saved") return
    setSaveStates((s) => ({ ...s, [m.id]: "saving" }))
    try {
      await createNote({
        source: "from-ask",
        raw_type: "text",
        content: buildAskNoteContent(m.question ?? "", m.content, m.refs ?? []),
        skip_triage: true, // 存为「想法」且不被 AI 重新分拣
        meta: { from_ask: true },
      })
      setSaveStates((s) => ({ ...s, [m.id]: "saved" }))
    } catch {
      setSaveStates((s) => ({ ...s, [m.id]: "error" }))
    }
  }

  const initialSentRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialQuestion) {
      initialSentRef.current = null
      return
    }
    if (initialSentRef.current === initialQuestion) return
    initialSentRef.current = initialQuestion
    onInitialQuestionConsumed?.()
    void send(initialQuestion)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send 依赖当前 state，仅在新问题到来时触发
  }, [initialQuestion])

  useEffect(() => {
    if (!initialInput) return
    setInput(initialInput)
    onInitialInputConsumed?.()
    inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在新预填到来时触发
  }, [initialInput])

  return (
    <Card className="flex flex-col gap-0 overflow-hidden p-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-primary" /> 和笔记对话
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              onClick={showHelp}
            >
              <CircleHelp className="size-3.5" /> 帮助
            </Button>
          )}
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
      </div>

      <div ref={listRef} className="max-h-[55vh] space-y-3 overflow-y-auto px-3 py-3 md:max-h-[420px]">
        {messages.length === 0 && !asking && (
          <div className="space-y-3 px-1 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              问问你的笔记，例如「我最近在想什么」「上次记的那个点子是什么」。
              <br />
              支持多轮追问，回答中的 [n] 可点击查看引用笔记。
            </p>
            <Button variant="outline" size="sm" onClick={showHelp}>
              <CircleHelp className="size-3.5" /> 你能做什么？
            </Button>
          </div>
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
                  <div className="space-y-2">
                    <p className="text-sm text-destructive">{m.content}</p>
                    {m.question && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={asking}
                        onClick={() => void send(m.question)}
                      >
                        重试
                      </Button>
                    )}
                  </div>
                ) : (
                  <AnswerText
                    msgId={m.id}
                    content={m.content}
                    refIndexes={new Set((m.refs ?? []).map((r) => r.index))}
                  />
                )}
                {!m.error && m.question && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={saveStates[m.id] === "saving" || saveStates[m.id] === "saved"}
                      onClick={() => void saveAsNote(m)}
                    >
                      {saveStates[m.id] === "saving" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : saveStates[m.id] === "saved" ? (
                        <Check className="size-3.5" />
                      ) : (
                        <BookmarkPlus className="size-3.5" />
                      )}
                      {saveStates[m.id] === "saved" ? "已存为笔记" : "存为笔记"}
                    </Button>
                    {saveStates[m.id] === "error" && (
                      <span className="text-xs text-destructive">保存失败，点击重试</span>
                    )}
                  </div>
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
          ref={inputRef}
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
