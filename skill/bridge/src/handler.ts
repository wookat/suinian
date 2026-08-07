import { FatalApiError, type SuinianClient } from './client.js'
import {
  isQuestion,
  stripQuestionPrefix,
  toIngestPayload,
  toMediaIngestPayload,
  type AskHistoryMessage,
  type NormalizedMessage,
} from './payload.js'

const FALLBACK_SAVED = '已收到，正在整理…（后端确认文案缺失）'
const ERR_SAVE = '保存失败了，稍后我会自动重试；也可以过一会儿重发一次。'
const FALLBACK_MEDIA_SAVED = '已记录，正在识别…'
const MEDIA_DOWNLOAD_FAILED: Record<'voice' | 'image', string> = {
  voice: '【语音】下载失败，未能转写，请重发一次',
  image: '【图片】下载失败，未能识别，请重发一次',
}

/** 文件上传/提取失败时的兜底入库文案（仅存档文件名） */
export function fileFallbackText(msg: NormalizedMessage): string {
  const name = msg.media?.[0]?.fileName || msg.text?.trim()
  return name ? `【文件】${name}` : '【文件】未能获取文件名，请重发一次'
}
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

  // 语音/图片：走 /api/ingest/media 转写/识别入库
  if (msg.type === 'voice' || msg.type === 'image') {
    const mediaPayload = toMediaIngestPayload(msg)
    if (mediaPayload) {
      try {
        const res = await client.ingestMedia(mediaPayload)
        if (res.note && !res.error) return res.reply ?? FALLBACK_MEDIA_SAVED
        return res.error ? `保存失败：${res.error}` : ERR_SAVE
      } catch (err) {
        if (err instanceof FatalApiError) throw err
        return ERR_SAVE
      }
    }
    // 媒体下载失败/超限：占位文字入库，提醒用户重发
    msg = { ...msg, text: msg.text?.trim() || MEDIA_DOWNLOAD_FAILED[msg.type] }
  }

  // 文件：上传 /api/ingest/media 提取+存档；失败兜底仅存档文件名
  if (msg.type === 'file') {
    const mediaPayload = toMediaIngestPayload(msg)
    if (mediaPayload) {
      try {
        const res = await client.ingestMedia(mediaPayload)
        if (res.note && !res.error) return res.reply ?? FALLBACK_MEDIA_SAVED
      } catch (err) {
        if (err instanceof FatalApiError) throw err
        // 非致命失败：落到文件名存档兜底
      }
    }
    msg = { ...msg, text: fileFallbackText(msg) }
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
