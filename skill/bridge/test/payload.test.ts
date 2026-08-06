import { describe, expect, it } from 'vitest'
import {
  extractUrl,
  isBareLink,
  isQuestion,
  stripQuestionPrefix,
  toIngestPayload,
} from '../src/payload.js'

describe('isQuestion / stripQuestionPrefix', () => {
  it('半角 ? 开头', () => {
    expect(isQuestion('?上周我在想什么')).toBe(true)
    expect(stripQuestionPrefix('?上周我在想什么')).toBe('上周我在想什么')
  })
  it('全角 ？ 开头（含前导空白）', () => {
    expect(isQuestion('  ？找一下关于AI的笔记')).toBe(true)
    expect(stripQuestionPrefix('  ？找一下关于AI的笔记')).toBe('找一下关于AI的笔记')
  })
  it('非问句', () => {
    expect(isQuestion('这是一个想法?')).toBe(false)
    expect(isQuestion('')).toBe(false)
  })
})

describe('extractUrl', () => {
  it('提取文本中的 URL', () => {
    expect(extractUrl('看这个 https://example.com/a?b=1 不错')).toBe('https://example.com/a?b=1')
  })
  it('中文标点截断', () => {
    expect(extractUrl('https://example.com/x，后面是中文')).toBe('https://example.com/x')
  })
  it('无 URL 返回 undefined', () => {
    expect(extractUrl('没有链接')).toBeUndefined()
  })
})

describe('toIngestPayload', () => {
  it('纯链接 → raw_type=link + url 字段', () => {
    const p = toIngestPayload({ userId: 'u1', text: 'https://example.com/article', type: 'text' })
    expect(p.raw_type).toBe('link')
    expect(p.url).toBe('https://example.com/article')
    expect(p.source).toBe('wechat')
  })
  it('长文本带链接 → raw_type=text 但仍带 url', () => {
    const long = '这是一段很长很长很长很长的想法，顺便附一个链接 https://example.com 记录一下今天的思考'
    const p = toIngestPayload({ userId: 'u1', text: long, type: 'text' })
    expect(p.raw_type).toBe('text')
    expect(p.url).toBe('https://example.com')
  })
  it('图片消息 → raw_type=image + attachments', () => {
    const p = toIngestPayload({
      userId: 'u1', text: '', type: 'image',
      media: [{ mime: 'image/png', size: 3, fileName: 'a.png', data: Buffer.from('abc') }],
    })
    expect(p.raw_type).toBe('image')
    expect(p.attachments?.[0].data_base64).toBe(Buffer.from('abc').toString('base64'))
  })
  it('超大文件不内联 base64', () => {
    const big = Buffer.alloc(9 * 1024 * 1024)
    const p = toIngestPayload({
      userId: 'u1', text: '', type: 'file',
      media: [{ mime: 'application/pdf', size: big.length, fileName: 'big.pdf', data: big }],
    })
    expect(p.raw_type).toBe('file')
    expect(p.attachments?.[0].data_base64).toBeUndefined()
    expect(p.attachments?.[0].size).toBe(big.length)
  })
  it('语音 → raw_type=voice', () => {
    const p = toIngestPayload({ userId: 'u1', text: '', type: 'voice' })
    expect(p.raw_type).toBe('voice')
  })
})

describe('isBareLink', () => {
  it('纯链接', () => {
    expect(isBareLink('https://a.com', 'https://a.com')).toBe(true)
  })
  it('链接+长评论不算', () => {
    const t = '这篇文章讲得非常好，值得反复阅读，特别是关于AI的部分 https://a.com'
    expect(isBareLink(t, 'https://a.com')).toBe(false)
  })
})
