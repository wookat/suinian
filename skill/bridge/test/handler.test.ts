import { describe, expect, it, vi } from 'vitest'
import { handleMessage } from '../src/handler.js'
import type { SuinianClient } from '../src/client.js'

function fakeClient(overrides: Partial<Record<'ingest' | 'ask', unknown>> = {}) {
  return {
    ingest: vi.fn(async () => ({ ok: true, note_id: 'n1', reply: '已存：想法 #a #b' })),
    ask: vi.fn(async () => ({ ok: true, answer: '这是答案', note_ids: ['n1'] })),
    ...overrides,
  } as unknown as SuinianClient
}

describe('handleMessage', () => {
  it('普通文本 → ingest 并回复后端确认文案', async () => {
    const client = fakeClient()
    const reply = await handleMessage(client, { userId: 'u1', text: '一个想法', type: 'text' })
    expect(reply).toBe('已存：想法 #a #b')
    expect((client.ingest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      source: 'wechat', raw_type: 'text', content: '一个想法',
    })
  })

  it('? 开头 → ask 并回复答案', async () => {
    const client = fakeClient()
    const reply = await handleMessage(client, { userId: 'u1', text: '?上周在想什么', type: 'text' })
    expect(reply).toBe('这是答案')
    expect((client.ask as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      question: '上周在想什么',
    })
  })

  it('空问句 → 提示写问题，不打后端', async () => {
    const client = fakeClient()
    const reply = await handleMessage(client, { userId: 'u1', text: '?', type: 'text' })
    expect(reply).toContain('想问什么')
    expect(client.ask).not.toHaveBeenCalled()
  })

  it('ingest 网络失败 → 友好错误文案', async () => {
    const client = fakeClient({ ingest: vi.fn(async () => { throw new Error('boom') }) })
    const reply = await handleMessage(client, { userId: 'u1', text: 'x', type: 'text' })
    expect(reply).toContain('保存失败')
  })

  it('图片消息不会被当成问答', async () => {
    const client = fakeClient()
    await handleMessage(client, { userId: 'u1', text: '?看起来像问句的caption', type: 'image' })
    expect(client.ingest).toHaveBeenCalled()
    expect(client.ask).not.toHaveBeenCalled()
  })
})
