/**
 * 冒烟脚本：启动 mock 后端 → 用真实 SuinianClient + handleMessage 走完整链路（不含微信侧）。
 * 运行：npm run smoke
 */
import { spawn } from 'node:child_process'
import { SuinianClient } from '../src/client.js'
import { handleMessage } from '../src/handler.js'

const PORT = 18788
const TOKEN = 'smoke-token'

async function waitForServer(url: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: 'POST' })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error('mock server 未启动')
}

async function main() {
  const mock = spawn(process.execPath, ['--import', 'tsx', 'mock/server.ts'], {
    env: { ...process.env, MOCK_PORT: String(PORT), MOCK_TOKEN: TOKEN },
    stdio: 'inherit',
  })
  try {
    await waitForServer(`http://localhost:${PORT}/api/ask`)
    const client = new SuinianClient({
      apiUrl: `http://localhost:${PORT}`,
      token: TOKEN,
      requestTimeoutMs: 5000,
      maxRetries: 1,
    })

    const cases: [string, Parameters<typeof handleMessage>[1], (r: string) => boolean][] = [
      ['文本入库', { userId: 'u1', text: '今天想到一个创业点子', type: 'text' }, (r) => r.startsWith('已存：想法')],
      ['待办入库', { userId: 'u1', text: '记得下周约医生', type: 'text' }, (r) => r.startsWith('已存：待办')],
      ['链接入库', { userId: 'u1', text: 'https://example.com/article', type: 'text' }, (r) => r.startsWith('已存：收藏')],
      ['图片入库', { userId: 'u1', text: '', type: 'image', media: [{ mime: 'image/png', size: 3, data: Buffer.from('abc') }] }, (r) => r.startsWith('已存：')],
      ['问答', { userId: 'u1', text: '?我最近在想什么', type: 'text' }, (r) => r.includes('我最近在想什么')],
    ]

    let failed = 0
    for (const [name, msg, check] of cases) {
      const reply = await handleMessage(client, msg)
      const ok = check(reply)
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${reply}`)
      if (!ok) failed++
    }

    // 错误 token → 应抛 FatalApiError
    const badClient = new SuinianClient({
      apiUrl: `http://localhost:${PORT}`, token: 'wrong', requestTimeoutMs: 5000, maxRetries: 0,
    })
    try {
      await handleMessage(badClient, { userId: 'u1', text: 'x', type: 'text' })
      console.log('FAIL 错误token应抛FatalApiError')
      failed++
    } catch {
      console.log('PASS 错误token抛FatalApiError')
    }

    if (failed) {
      console.error(`\n冒烟失败：${failed} 项`)
      process.exit(1)
    }
    console.log('\n冒烟全部通过 ✔')
  } finally {
    mock.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
