import { describe, expect, it, vi } from 'vitest'
import { AskContextStore, handleMessage } from '../src/handler.js'
import type { SuinianClient } from '../src/client.js'

function fakeClient(overrides: Partial<Record<'ingest' | 'ask' | 'ingestMedia', unknown>> = {}) {
  return {
    ingest: vi.fn(async () => ({ ok: true, note_id: 'n1', reply: '已存：想法 #a #b' })),
    ask: vi.fn(async () => ({ ok: true, answer: '这是答案' })),
    ingestMedia: vi.fn(async () => ({ note: { id: 'n2' }, text: '转写文字', reply: '已记录（语音转写）：转写文字' })),
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

  it('后端成功响应不带 ok 字段也视为成功', async () => {
    const client = fakeClient({ ask: vi.fn(async () => ({ answer: '无 ok 字段的答案' })) })
    const reply = await handleMessage(client, { userId: 'u1', text: '?问', type: 'text' })
    expect(reply).toBe('无 ok 字段的答案')
  })

  it('多轮问答：第二问携带第一轮 history', async () => {
    const store = new AskContextStore()
    const client = fakeClient()
    await handleMessage(client, { userId: 'u1', text: '?flomo 是什么', type: 'text' }, store)
    await handleMessage(client, { userId: 'u1', text: '?它的定价呢', type: 'text' }, store)
    const ask = client.ask as ReturnType<typeof vi.fn>
    expect(ask.mock.calls[0][0].history).toBeUndefined()
    expect(ask.mock.calls[1][0].history).toEqual([
      { role: 'user', content: 'flomo 是什么' },
      { role: 'assistant', content: '这是答案' },
    ])
  })

  it('多轮上下文按用户隔离', async () => {
    const store = new AskContextStore()
    const client = fakeClient()
    await handleMessage(client, { userId: 'u1', text: '?问题A', type: 'text' }, store)
    await handleMessage(client, { userId: 'u2', text: '?问题B', type: 'text' }, store)
    const ask = client.ask as ReturnType<typeof vi.fn>
    expect(ask.mock.calls[1][0].history).toBeUndefined()
  })

  it('问答失败不写入上下文', async () => {
    const store = new AskContextStore()
    const client = fakeClient({ ask: vi.fn(async () => ({ ok: false, error: 'x' })) })
    await handleMessage(client, { userId: 'u1', text: '?问一', type: 'text' }, store)
    expect(store.getHistory('u1')).toEqual([])
  })
})

describe('AskContextStore', () => {
  it('只保留最近 3 轮', () => {
    const store = new AskContextStore()
    for (let i = 1; i <= 5; i++) store.remember('u1', `q${i}`, `a${i}`)
    const history = store.getHistory('u1')
    expect(history).toHaveLength(6)
    expect(history[0]).toEqual({ role: 'user', content: 'q3' })
    expect(history[5]).toEqual({ role: 'assistant', content: 'a5' })
  })

  it('超过 30 分钟过期', () => {
    const store = new AskContextStore()
    const t0 = 1_000_000
    store.remember('u1', 'q1', 'a1', t0)
    expect(store.getHistory('u1', t0 + 29 * 60 * 1000)).toHaveLength(2)
    expect(store.getHistory('u1', t0 + 31 * 60 * 1000)).toEqual([])
  })

  it('过期后 remember 重新开始新上下文', () => {
    const store = new AskContextStore()
    const t0 = 1_000_000
    store.remember('u1', 'q1', 'a1', t0)
    store.remember('u1', 'q2', 'a2', t0 + 31 * 60 * 1000)
    expect(store.getHistory('u1', t0 + 31 * 60 * 1000)).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ])
  })
})

describe('handleMessage 媒体消息（语音/图片）', () => {
  const voiceMedia = { mime: 'audio/wav', size: 3, data: Buffer.from('abc') }

  it('带媒体的语音 → ingestMedia 并回复转写确认', async () => {
    const client = fakeClient()
    const reply = await handleMessage(client, {
      userId: 'u1', text: '', type: 'voice', media: [voiceMedia],
    })
    expect(reply).toBe('已记录（语音转写）：转写文字')
    expect((client.ingestMedia as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      type: 'audio', mime: 'audio/wav', source: 'wechat',
    })
    expect(client.ingest).not.toHaveBeenCalled()
  })

  it('带媒体的图片 → ingestMedia type=image', async () => {
    const client = fakeClient({
      ingestMedia: vi.fn(async () => ({ note: { id: 'n3' }, reply: '已记录（图片识别）：会议纪要' })),
    })
    const reply = await handleMessage(client, {
      userId: 'u1', text: '', type: 'image',
      media: [{ mime: 'image/png', size: 3, data: Buffer.from('png') }],
    })
    expect(reply).toBe('已记录（图片识别）：会议纪要')
  })

  it('媒体下载失败（无 data）→ 占位文字走普通 ingest 并可提醒重发', async () => {
    const client = fakeClient()
    await handleMessage(client, { userId: 'u1', text: '', type: 'voice' })
    expect(client.ingestMedia).not.toHaveBeenCalled()
    expect((client.ingest as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      raw_type: 'voice', content: '【语音】下载失败，未能转写，请重发一次',
    })
  })

  it('ingestMedia 网络失败 → 友好错误文案', async () => {
    const client = fakeClient({ ingestMedia: vi.fn(async () => { throw new Error('boom') }) })
    const reply = await handleMessage(client, {
      userId: 'u1', text: '', type: 'voice', media: [voiceMedia],
    })
    expect(reply).toContain('保存失败')
  })
})
