import { FatalApiError, type SuinianClient } from './client.js'
import {
  extractInlineTags,
  isForceSave,
  isHelpCommand,
  isQuestion,
  stripForceSavePrefix,
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
const EMPTY_FORCE_SAVE = '想存什么？在 ! 后面写上内容，例如「!会议纪要：…」。'

export const HELP_TEXT = [
  '我是「碎念」，想到什么直接丢给我：',
  '• 直接发文字/链接/语音/图片/文件 → 自动分拣为想法/待办/收藏/资料',
  '• ?问题 → 基于你的笔记问答，如「?上周我在想什么」（支持多轮追问）',
  '• !内容 → 强制原样保存，不走 AI 分拣',
  '• #标签 内容 → 手动打标签，如「#灵感 做个周报邮件推送」',
  '• 待办会识别截止时间；每天推送回顾；每周一生成周报',
  '• 网页版 https://suinian.zalize.com 可搜索/编辑/导出全部笔记',
].join('\n')

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
  if (msg.type === 'text' && isHelpCommand(text)) {
    return HELP_TEXT
  }
  if (msg.type === 'text' && isForceSave(text)) {
    const rest = stripForceSavePrefix(text)
    if (!rest) return EMPTY_FORCE_SAVE
    const { content, tags } = extractInlineTags(rest)
    const payload = toIngestPayload({ ...msg, text: content })
    payload.skip_triage = true
    if (tags.length > 0) payload.tags = tags
    try {
      const res = await client.ingest(payload)
      if (res.ok) return res.reply ?? FALLBACK_SAVED
      return res.error ? `保存失败：${res.error}` : ERR_SAVE
    } catch (err) {
      if (err instanceof FatalApiError) throw err
      return ERR_SAVE
    }
  }
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

  // 普通消息：`#标签` 手动打标（仍走 AI 分拣，但标签以手动为准）
  const inline = msg.type === 'text' ? extractInlineTags(msg.text ?? '') : null
  const payload =
    inline && inline.tags.length > 0 ? toIngestPayload({ ...msg, text: inline.content }) : toIngestPayload(msg)
  if (inline && inline.tags.length > 0) payload.tags = inline.tags
  try {
    const res = await client.ingest(payload)
    if (res.ok) return res.reply ?? FALLBACK_SAVED
    return res.error ? `保存失败：${res.error}` : ERR_SAVE
  } catch (err) {
    if (err instanceof FatalApiError) throw err
    return ERR_SAVE
  }
}
