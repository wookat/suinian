/**
 * 把微信 ClawBot 消息规整为后端 /api/ingest/wechat 的 note payload。
 * 接口形状严格按 docs/SPEC.md：{source, raw_type, content, url?} + 附件扩展。
 */

export type RawType = 'text' | 'link' | 'image' | 'voice' | 'file'

export interface IngestAttachment {
  mime: string
  size: number
  file_name?: string
  /** 小文件（<= 8MB）直接 base64 内联，由后端存 R2 */
  data_base64?: string
}

export interface IngestPayload {
  source: 'wechat'
  raw_type: RawType
  content: string
  url?: string
  wechat_user_id: string
  wechat_message_id?: string
  created_at?: string
  attachments?: IngestAttachment[]
  /** `!` 强制保存：后端跳过 AI 分拣 */
  skip_triage?: boolean
  /** `#标签` 手动打标 */
  tags?: string[]
}

export interface MediaIngestPayload {
  type: 'audio' | 'image' | 'file'
  data_base64: string
  mime: string
  file_name?: string
  source: 'wechat'
}

/** 后端支持提取/存档的文件扩展名（与 backend/src/files.ts 保持一致） */
export const SUPPORTED_FILE_EXTS = ['pdf', 'txt', 'md', 'markdown', 'docx']

/** 文件消息是否属于后端支持的可提取类型 */
export function isSupportedFile(fileName?: string): boolean {
  const ext = fileName?.split('.').pop()?.toLowerCase()
  return !!ext && SUPPORTED_FILE_EXTS.includes(ext)
}

/** 需要走 /api/ingest/media 的媒体（语音/图片/文件且已下载到字节）→ payload；否则 null */
export function toMediaIngestPayload(msg: NormalizedMessage): MediaIngestPayload | null {
  if (msg.type !== 'voice' && msg.type !== 'image' && msg.type !== 'file') return null
  const media = msg.media?.[0]
  if (!media?.data || media.data.length === 0) return null
  if (media.data.length > MAX_MEDIA_BYTES) return null
  if (msg.type === 'file' && !isSupportedFile(media.fileName)) return null
  return {
    type: msg.type === 'voice' ? 'audio' : msg.type === 'image' ? 'image' : 'file',
    data_base64: media.data.toString('base64'),
    mime: media.mime,
    file_name: media.fileName,
    source: 'wechat',
  }
}

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024

export interface AskHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AskPayload {
  source: 'wechat'
  question: string
  wechat_user_id: string
  /** 最近几轮对话（多轮追问上下文），可选 */
  history?: AskHistoryMessage[]
}

const URL_RE = /https?:\/\/[^\s<>"'）)】\]，。；！？]+/i

/** 从文本中提取第一个 URL */
export function extractUrl(text: string): string | undefined {
  const m = text.match(URL_RE)
  return m ? m[0] : undefined
}

/** `?`/`？` 开头（允许前导空白）判定为问答 */
export function isQuestion(text: string): boolean {
  return /^\s*[?？]/.test(text)
}

/** 去掉问答前缀，得到问题正文 */
export function stripQuestionPrefix(text: string): string {
  return text.replace(/^\s*[?？]\s*/, '').trim()
}

/** `!`/`！` 开头：强制保存不分拣 */
export function isForceSave(text: string): boolean {
  return /^\s*[!！]/.test(text)
}

/** 去掉强制保存前缀 */
export function stripForceSavePrefix(text: string): string {
  return text.replace(/^\s*[!！]\s*/, '').trim()
}

/** “帮助 / 你能做什么 / help”之类的帮助指令 */
export function isHelpCommand(text: string): boolean {
  return /^\s*(帮助|你能做什么|使用说明|help)\s*[?？!！。]?\s*$/i.test(text)
}

const INLINE_TAG_RE = /#([^\s#!！?？,，。;；]{1,32})/g

/**
 * 提取文本中的 `#标签` 手动打标，返回去掉标签后的正文与标签列表。
 * 只有当标签位于开头或结尾时才从正文移除（避免拆坏句中话题词）。
 */
export function extractInlineTags(text: string): { content: string; tags: string[] } {
  const tags: string[] = []
  for (const m of text.matchAll(INLINE_TAG_RE)) {
    if (!tags.includes(m[1])) tags.push(m[1])
  }
  if (tags.length === 0) return { content: text.trim(), tags }
  // 仅剥离首尾的标签串，句中的 #词 保留在正文里
  let content = text.trim()
  const edge = /^(\s*#[^\s#!！?？,，。;；]{1,32})+\s*/
  const tail = /(\s*#[^\s#!！?？,，。;；]{1,32})+\s*$/
  content = content.replace(edge, '').replace(tail, '').trim()
  if (!content) content = text.trim()
  return { content, tags: tags.slice(0, 6) }
}

export interface NormalizedMessage {
  userId: string
  messageId?: string
  text: string
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  timestamp?: Date
  media?: { mime: string; size: number; fileName?: string; data?: Buffer }[]
}

/** 微信消息 → ingest payload */
export function toIngestPayload(msg: NormalizedMessage): IngestPayload {
  const text = (msg.text ?? '').trim()
  const url = extractUrl(text)
  let rawType: RawType
  switch (msg.type) {
    case 'image':
      rawType = 'image'
      break
    case 'voice':
      rawType = 'voice'
      break
    case 'file':
    case 'video':
      rawType = 'file'
      break
    default:
      rawType = url && isBareLink(text, url) ? 'link' : 'text'
  }
  const payload: IngestPayload = {
    source: 'wechat',
    raw_type: rawType,
    content: text,
    wechat_user_id: msg.userId,
  }
  if (url) payload.url = url
  if (msg.messageId) payload.wechat_message_id = msg.messageId
  if (msg.timestamp) payload.created_at = msg.timestamp.toISOString()
  if (msg.media?.length) {
    payload.attachments = msg.media.map((m) => ({
      mime: m.mime,
      size: m.size,
      file_name: m.fileName,
      data_base64: m.data && m.data.length <= 8 * 1024 * 1024 ? m.data.toString('base64') : undefined,
    }))
  }
  return payload
}

/** 文本去掉 URL 后几乎没有别的内容 → 视为纯链接分享 */
export function isBareLink(text: string, url: string): boolean {
  return text.replace(url, '').trim().length <= 20
}
