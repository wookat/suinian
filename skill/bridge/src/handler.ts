import { FatalApiError, type SuinianClient } from './client.js'
import {
  isQuestion,
  stripQuestionPrefix,
  toIngestPayload,
  type AskHistoryMessage,
  type NormalizedMessage,
} from './payload.js'

const FALLBACK_SAVED = '已收到，正在整理…（后端确认文案缺失）'
const ERR_SAVE = '保存失败了，稍后我会自动重试；也可以过一会儿重发一次。'
const ERR_ASK = '检索出错了，请稍后再问一次。'
const EMPTY_QUESTION = '想问什么？在 ? 后面写上问题，例如「?上周我在想什么」。'

const ASK_CONTEXT_ROUNDS = 3
const ASK_CONTEXT_TTL_MS = 30 * 60 * 1000

interface AskTurn {
  question: string
  answer: string
}

/** 每个微信用户最近几轮问答的内存上下文，30 分钟不问则过期 */
export class AskContextStore {
  private readonly contexts = new Map<string, { turns: AskTurn[]; updatedAt: number }>()

  constructor(
    private readonly maxRounds = ASK_CONTEXT_ROUNDS,
    private readonly ttlMs = ASK_CONTEXT_TTL_MS,
  ) {}

  getHistory(userId: string, now = Date.now()): AskHistoryMessage[] {
    const ctx = this.contexts.get(userId)
    if (!ctx) return []
    if (now - ctx.updatedAt > this.ttlMs) {
      this.contexts.delete(userId)
      return []
    }
    return ctx.turns.flatMap((t) => [
      { role: 'user' as const, content: t.question },
      { role: 'assistant' as const, content: t.answer },
    ])
  }

  remember(userId: string, question: string, answer: string, now = Date.now()): void {
    const ctx = this.contexts.get(userId)
    const turns = ctx && now - ctx.updatedAt <= this.ttlMs ? ctx.turns : []
    turns.push({ question, answer })
    this.contexts.set(userId, { turns: turns.slice(-this.maxRounds), updatedAt: now })
  }

  clear(userId: string): void {
    this.contexts.delete(userId)
  }
}

const defaultAskContexts = new AskContextStore()

/**
 * 单条消息的核心处理逻辑（与 SDK 解耦，便于单测）：
 * `?`/`？` 开头 → /api/ask 问答；其余 → /api/ingest/wechat 收件。
 * 返回要回复给用户的文案。
 */
export async function handleMessage(
  client: SuinianClient,
  msg: NormalizedMessage,
  askContexts: AskContextStore = defaultAskContexts,
): Promise<string> {
  const text = (msg.text ?? '').trim()
  if (msg.type === 'text' && isQuestion(text)) {
    const question = stripQuestionPrefix(text)
    if (!question) return EMPTY_QUESTION
    try {
      const history = askContexts.getHistory(msg.userId)
      const res = await client.ask({
        source: 'wechat',
        question,
        wechat_user_id: msg.userId,
        ...(history.length > 0 ? { history } : {}),
      })
      if ((res.ok ?? true) && res.answer) {
        askContexts.remember(msg.userId, question, res.answer)
        return res.answer
      }
      return res.error ? `检索失败：${res.error}` : ERR_ASK
    } catch (err) {
      if (err instanceof FatalApiError) throw err
      return ERR_ASK
    }
  }

  const payload = toIngestPayload(msg)
  try {
    const res = await client.ingest(payload)
    if (res.ok) return res.reply ?? FALLBACK_SAVED
    return res.error ? `保存失败：${res.error}` : ERR_SAVE
  } catch (err) {
    if (err instanceof FatalApiError) throw err
    return ERR_SAVE
  }
}
