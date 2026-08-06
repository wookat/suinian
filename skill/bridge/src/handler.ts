import { FatalApiError, type SuinianClient } from './client.js'
import {
  isQuestion,
  stripQuestionPrefix,
  toIngestPayload,
  type NormalizedMessage,
} from './payload.js'

const FALLBACK_SAVED = '已收到，正在整理…（后端确认文案缺失）'
const ERR_SAVE = '保存失败了，稍后我会自动重试；也可以过一会儿重发一次。'
const ERR_ASK = '检索出错了，请稍后再问一次。'
const EMPTY_QUESTION = '想问什么？在 ? 后面写上问题，例如「?上周我在想什么」。'

/**
 * 单条消息的核心处理逻辑（与 SDK 解耦，便于单测）：
 * `?`/`？` 开头 → /api/ask 问答；其余 → /api/ingest/wechat 收件。
 * 返回要回复给用户的文案。
 */
export async function handleMessage(
  client: SuinianClient,
  msg: NormalizedMessage,
): Promise<string> {
  const text = (msg.text ?? '').trim()
  if (msg.type === 'text' && isQuestion(text)) {
    const question = stripQuestionPrefix(text)
    if (!question) return EMPTY_QUESTION
    try {
      const res = await client.ask({ source: 'wechat', question, wechat_user_id: msg.userId })
      if (res.ok && res.answer) return res.answer
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
