import { useEffect, useRef, useState } from "react"
import {
  BookmarkPlus,
  Check,
  CircleHelp,
  Loader2,
  RefreshCw,
  SendHorizontal,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { NoteCard } from "@/components/note-card"
import { askStream, createNote } from "@/lib/api"
import { loadSettings, useSettingsVersion } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { AskHistoryMessage, Note } from "@/lib/types"

const LEGACY_STORAGE_KEY = "suinian-ask-chat-v1" // 旧版全局共享 key，会跨账号泄露，读到即删
const STORAGE_PREFIX = "suinian-ask-chat-v2:"
const HISTORY_MAX_MESSAGES = 6 // 最近 3 轮
// 上下文时效（R284 F-8b，audit-r283）：问答历史持久化在 localStorage，旧实现
// 把最近 6 条一律当上下文发给服务端——面板关掉几小时、甚至隔天再问，新问题
// 仍被上一段对话的话题带偏，只有刷新页面（重新挂载）后才「像是」正常。改为
// 按时间切会话：只有与本次提问间隔 < CONTEXT_TTL_MS 且彼此连续的尾部消息才
// 作为上下文，过期消息仍留在界面上可读，但不再进模型上下文。
const CONTEXT_TTL_MS = 30 * 60 * 1000

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
  "• 随手记：首页输入框丢文字/链接/图片/文件，AI 自动分拣为想法/待办/收藏/资料（微信通道开通后还可直接发消息记）",
  "• 问答：在这里直接提问，如「我最近在想什么」，支持多轮追问，回答中 [n] 可点击查看引用笔记",
  "• 快捷指令（首页速记框，微信通道同样适用）：?问题 提问；!内容 强制原样保存不分拣；#标签 内容 手动打标",
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
  /** 服务端安全收口对答案做了隔离/警示改写（R278 P1-4） */
  isolated?: boolean
  /** 危险代码判别器不可用，本轮为保守隔离（R288 P2-1：可重试拿到完整答案） */
  guardDegraded?: boolean
  /** 消息产生时刻（epoch ms）；旧版本存量消息无此字段，一律按过期处理 */
  ts?: number
}

/**
 * 取本次提问应携带的上下文（R284 F-8b）：从尾部往前收，遇到无时间戳、超过
 * CONTEXT_TTL_MS、或与后一条间隔超过 TTL 的消息即停——同一段连续对话才算
 * 一个会话，跨时段的陈旧轮次不再复用。
 */
export function selectAskContext(messages: AskChatMessage[], now: number): AskHistoryMessage[] {
  const picked: AskChatMessage[] = []
  let next = now
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.error) continue
    if (typeof m.ts !== "number" || next - m.ts > CONTEXT_TTL_MS) break
    picked.push(m)
    next = m.ts
    if (picked.length >= HISTORY_MAX_MESSAGES) break
  }
  return picked.reverse().map((m) => ({ role: m.role, content: m.content }))
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
    if (!Array.isArray(parsed)) return []
    // 网络错误卡只属于当次会话（R228 P3-5）：面板重开时不再残留过期的
    // 「服务不可用」卡片，其对应的问题可从输入框重问
    return (parsed as AskChatMessage[]).filter((m) => !m.error)
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

// 隔离标记短句化（R294 P2-3，audit-r293 §9.3）：服务端标记为防仿冒是较长的
// 固定文案，渲染层换成短句，「查看原文」由横幅按钮承担。只改展示，存为笔记
// 仍用原文。
const GUARD_MARK_SHORTS: [string, string][] = [
  ["〔已隔离笔记内指令，未采纳；原文可在引用的笔记卡片中查看〕", "〔已隔离笔记内指令〕"],
  ["〔已隔离危险命令（会下载执行远程代码或建立外连），未展示；原文可在引用的笔记卡片中查看〕", "〔已隔离危险命令〕"],
  ["〔代码安全判别暂不可用，已对疑似可执行代码保守隔离（未展示）；原文可在引用的笔记卡片中查看〕", "〔判别暂不可用，已保守隔离〕"],
  ["相关笔记内容命中安全隔离规则，已隔离未采纳；原文可在引用的笔记卡片中查看。", "相关内容命中安全隔离规则，已隔离未采纳。"],
]
// 降级窗口的答尾长提示整句折进横幅（横幅已说明降级+可重试），正文不重复。
const DEGRADED_NOTICE_RE =
  /\n*（本次回答处于代码安全判别降级窗口：判别服务超时\/不可用，系统已对代码区域保守隔离，稍后重试可获得完整判定。）\n*/g

export function shortenGuardMarks(content: string): string {
  let out = content.replace(DEGRADED_NOTICE_RE, "\n")
  for (const [long, short] of GUARD_MARK_SHORTS) out = out.split(long).join(short)
  return out.trim()
}

// 隔离位置定位（R296 P2-1，audit-r295：提示从「吓人」矫枉到「看不懂」）：
// 找到含隔离标记的那一段（非空行序号）与同段的 [n] 引用，横幅里告诉用户
// 被隔离的是哪一条，「查看原文」直接滚到对应笔记卡片。
const ISOLATION_MARK_RE = /〔已隔离|命中安全隔离规则|〔代码安全判别暂不可用/
// 原文类问法（与后端 questionRequestsVerbatim 同口径的轻量版）：回答下方提示
// 「近似原文」口径，告知空白/换行/零宽字符可能被归一化。
const VERBATIM_QUESTION_RE = /原文|原样|原话|原封不动|逐字|一字不差|一字不漏|一字一句|verbatim|word for word/i
export function isolatedMarkLocation(content: string): { para: number; refIndex: number | null } | null {
  const lines = shortenGuardMarks(content)
    .split("\n")
    .filter((l) => l.trim().length > 0)
  for (let i = 0; i < lines.length; i++) {
    if (!ISOLATION_MARK_RE.test(lines[i])) continue
    const m = lines[i].match(/[[［](\d{1,2})[\]］]/)
    return { para: i + 1, refIndex: m ? parseInt(m[1], 10) : null }
  }
  return null
}

/** 把回答中的 [n] 渲染为可点击引用，点击滚动到下方对应笔记卡片 */
function AnswerText({ msgId, content, refIndexes }: { msgId: string; content: string; refIndexes: Set<number> }) {
  const parts = shortenGuardMarks(content).split(/([[［]\d{1,2}[\]］])/g)
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
      {parts.map((part, i) => {
        const m = part.match(/^[[［](\d{1,2})[\]］]$/)
        const n = m ? parseInt(m[1], 10) : null
        if (n !== null && refIndexes.has(n)) {
          return (
            <button
              key={i}
              className="relative mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1 align-text-bottom text-xs font-medium text-primary before:absolute before:-inset-1 before:content-[''] hover:bg-primary/25"
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
  onClose,
}: {
  onTagClick?: (tag: string) => void
  /** 首页速记框 `?问题` 内联指令带过来的问题，挂载/变化时自动发送 */
  initialQuestion?: string | null
  onInitialQuestionConsumed?: () => void
  /** 预填到输入框但不自动发送（搜索空态「用 AI 问问看」：由用户确认后再消耗 AI 调用） */
  initialInput?: string | null
  onInitialInputConsumed?: () => void
  /** Esc 关闭面板（与删除确认弹窗行为一致） */
  onClose?: () => void
}) {
  const [messages, setMessages] = useState<AskChatMessage[]>(loadMessages)
  const [input, setInput] = useState("")
  const [asking, setAsking] = useState(false)
  // 流式中间态（R174 SSE）：meta = 已检索 N 条；text = 生成中的正文增量。
  // 正文里的 [n] 角标在流式期间按纯文本展示，done 后用引证补全的最终全文
  // 一次性替换，角标才变为可点击引用（保证引证确定性）。
  const [streamState, setStreamState] = useState<{ retrieved: number | null; text: string }>({ retrieved: null, text: "" })
  const abortRef = useRef<AbortController | null>(null)
  const [saveStates, setSaveStates] = useState<Record<string, "saving" | "saved" | "error">>({})
  const [confirmClear, setConfirmClear] = useState(false)
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

  // Esc 关闭问答面板；确认弹窗打开时让弹窗自己处理 Esc，不双重关闭
  useEffect(() => {
    if (!onClose || confirmClear) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose, confirmClear])

  const hasStreamText = streamState.text.length > 0
  // 只滚内部列表容器，不用 scrollIntoView（R296 P3-1，audit-r295：375px 多轮
  // 对话后它会连带滚动页面，把卡片底部的输入框挤出可视区）。
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages.length, asking, hasStreamText])

  // 上下文在发送时按当下时刻现算（见 selectAskContext）：useMemo 只依赖
  // messages 会把「面板停留很久」这一情况算漏，故 send() 内直接调用。
  const historyRef = useRef<AskChatMessage[]>(messages)
  useEffect(() => {
    historyRef.current = messages
  }, [messages])

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
    setStreamState({ retrieved: null, text: "" })
    const controller = new AbortController()
    abortRef.current = controller
    const history = selectAskContext(historyRef.current, Date.now())
    const userMsg: AskChatMessage = { id: crypto.randomUUID(), role: "user", content: q, ts: Date.now() }
    setMessages((ms) => [...ms, userMsg])
    try {
      const res = await askStream(
        q,
        history,
        {
          onMeta: (m) => setStreamState((s) => ({ ...s, retrieved: m.retrieved })),
          onDelta: (t) => setStreamState((s) => ({ ...s, text: s.text + t })),
        },
        controller.signal,
      )
      const refs = (res.references ?? []).flatMap((r) => {
        const note = res.notes.find((n) => n.id === r.note_id)
        return note ? [{ index: r.index, note }] : []
      })
      setMessages((ms) => [
        ...ms,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: res.answer,
          refs,
          question: q,
          ts: Date.now(),
          ...(res.instruction_isolated ? { isolated: true } : {}),
          ...(res.exec_guard_degraded ? { guardDegraded: true } : {}),
        },
      ])
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && controller.signal.aborted) {
        // 用户主动取消：不算错误，保留问题方便重发
        setMessages((ms) => [
          ...ms,
          { id: crypto.randomUUID(), role: "assistant", content: "已取消本次回答。", question: q, error: true },
        ])
        return
      }
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
      abortRef.current = null
      setAsking(false)
      setStreamState({ retrieved: null, text: "" })
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
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-3.5" /> 清空对话
            </Button>
          )}
        </div>
      </div>

      {/* dvh 口径（R296 P3-1）：移动端地址栏/键盘收起时 vh 会大于可视高度，
          55vh 列表 + 头部 + 输入框在 375px 小屏上溢出，输入框落到可视区外。 */}
      <div ref={listRef} className="max-h-[45dvh] space-y-3 overflow-y-auto px-3 py-3 md:max-h-[420px]">
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
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.content}</p>
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
                  <>
                    {m.guardDegraded ? (
                      <div className="min-w-0 space-y-1.5 rounded-lg bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-800 [overflow-wrap:anywhere] dark:text-sky-300">
                        <div className="flex items-start gap-1.5">
                          <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
                          <span>安全判别暂不可用，代码/命令已暂时隐去，稍后重试可看到完整内容。</span>
                        </div>
                        {m.question && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={asking}
                            onClick={() => void send(m.question)}
                          >
                            <RefreshCw className="size-3.5" />
                            重试本轮提问
                          </Button>
                        )}
                      </div>
                    ) : null}
                    {m.isolated && !m.guardDegraded && (() => {
                      const loc = isolatedMarkLocation(m.content)
                      const refIndexes = new Set((m.refs ?? []).map((r) => r.index))
                      const targetIndex =
                        loc?.refIndex != null && refIndexes.has(loc.refIndex) ? loc.refIndex : m.refs?.[0]?.index
                      const targetNote =
                        targetIndex != null ? m.refs!.find((r) => r.index === targetIndex)?.note : undefined
                      const noteLabel = targetNote
                        ? (targetNote.title || targetNote.content).replace(/\s+/g, " ").slice(0, 12)
                        : null
                      return (
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 [overflow-wrap:anywhere] dark:text-amber-300">
                          <ShieldAlert className="size-3.5 shrink-0" />
                          <span className="min-w-0 flex-1">
                            {loc
                              ? `回答第 ${loc.para} 段中的内容已被安全隔离，未采纳${noteLabel ? `（关于「${noteLabel}」的那条笔记）` : ""}；笔记原文仍在，未被修改。`
                              : "部分内容已被安全隔离，未采纳；笔记原文仍在，未被修改。"}
                          </span>
                          {targetIndex != null && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                const el = document.getElementById(`ask-ref-${m.id}-${targetIndex}`)
                                el?.scrollIntoView({ behavior: "smooth", block: "center" })
                                el?.classList.add("ring-2", "ring-primary")
                                window.setTimeout(() => el?.classList.remove("ring-2", "ring-primary"), 1600)
                              }}
                            >
                              查看原文
                            </Button>
                          )}
                        </div>
                      )
                    })()}
                    <AnswerText
                      msgId={m.id}
                      content={m.content}
                      refIndexes={new Set((m.refs ?? []).map((r) => r.index))}
                    />
                    {m.question && VERBATIM_QUESTION_RE.test(m.question) && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="min-h-6 cursor-pointer select-none list-none py-1 underline decoration-dotted underline-offset-2">
                          关于原文回显的说明
                        </summary>
                        <p className="pt-1">
                          回答区不逐字转写笔记原文；空白/换行/零宽字符可能被归一化。完全逐字内容请打开下方引用的笔记卡片查看。
                        </p>
                      </details>
                    )}
                  </>
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
            <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm bg-accent/60 px-3.5 py-2">
              {streamState.text ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{streamState.text}</p>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {streamState.retrieved !== null
                    ? `已找到 ${streamState.retrieved} 条相关笔记，正在生成回答…`
                    : "正在思考…"}
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => abortRef.current?.abort()}
              >
                取消
              </Button>
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
      <ConfirmDialog
        open={confirmClear}
        title="清空对话？"
        description="将删除本机保存的全部问答记录，无法恢复。"
        confirmLabel="清空"
        onConfirm={() => {
          setMessages([])
          setConfirmClear(false)
        }}
        onCancel={() => setConfirmClear(false)}
      />
    </Card>
  )
}
