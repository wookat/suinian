/**
 * 本地 mock 后端：接口形状严格按 docs/SPEC.md，用于后端未就绪时联调 bridge。
 * 运行：npm run mock （默认端口 8788，MOCK_PORT 可改；token 校验 MOCK_TOKEN，默认 test-token）
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8788)
const TOKEN = process.env.MOCK_TOKEN ?? 'test-token'

const CATEGORY_LABEL: Record<string, string> = {
  idea: '想法', todo: '待办', collect: '收藏', data: '资料',
}

const notes: unknown[] = []

const server = createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(404, { ok: false, error: 'not found' })
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(401, { ok: false, error: 'unauthorized' })
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let body: Record<string, unknown>
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return send(400, { ok: false, error: 'invalid json' })
  }

  if (req.url === '/api/ingest/wechat') {
    if (!body.raw_type || typeof body.content !== 'string') {
      return send(400, { ok: false, error: 'missing raw_type/content' })
    }
    // 假装 AI 分拣：链接→收藏，含“待办/记得”→待办，其余→想法
    const content = body.content as string
    const category =
      body.raw_type === 'link' ? 'collect' : /待办|记得|todo/i.test(content) ? 'todo' : 'idea'
    const tags = ['mock', String(body.raw_type)]
    const id = `note_${Date.now()}_${notes.length}`
    notes.push({ id, ...body, category, tags })
    console.log(`[mock] ingest #${notes.length}:`, body.raw_type, content.slice(0, 60))
    return send(200, {
      ok: true,
      note_id: id,
      reply: `已存：${CATEGORY_LABEL[category]} ${tags.map((t) => '#' + t).join(' ')}`,
    })
  }

  if (req.url === '/api/ask') {
    if (typeof body.question !== 'string' || !body.question) {
      return send(400, { ok: false, error: 'missing question' })
    }
    console.log('[mock] ask:', body.question)
    return send(200, {
      ok: true,
      answer: `（mock 回答）你问的是「${body.question}」。当前共有 ${notes.length} 条笔记。`,
      note_ids: [],
    })
  }

  return send(404, { ok: false, error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`[mock] suinian mock backend listening on http://localhost:${PORT} (token: ${TOKEN})`)
})
