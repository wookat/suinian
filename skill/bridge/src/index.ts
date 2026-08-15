import { WeChatBot, type IncomingMessage } from '@wechatbot/wechatbot'
import qrcode from 'qrcode-terminal'
import { loadConfig } from './config.js'
import { SuinianClient, FatalApiError } from './client.js'
import { handleMessage } from './handler.js'
import { ReplyQueue } from './queue.js'
import { DailyReviewPusher } from './review-push.js'
import { TodoReminderPusher } from './todo-push.js'
import type { NormalizedMessage } from './payload.js'

const cfg = loadConfig()
const client = new SuinianClient(cfg)
const replyQueue = new ReplyQueue(cfg.replyIntervalMs)

const bot = new WeChatBot({
  storageDir: cfg.storageDir,
  logLevel: cfg.logLevel,
})

// 每日「今日回顾」推送：上海时间 REVIEW_PUSH_HOUR 点（默认 8 点）推给已绑定用户
const reviewPusher = new DailyReviewPusher(
  client,
  (userId, text) => replyQueue.enqueue(() => bot.send(userId, text).then(() => undefined)),
  { storageDir: cfg.storageDir, pushHour: Number(process.env.REVIEW_PUSH_HOUR ?? 8) },
)

// 每日待办提醒推送：上海时间 TODO_PUSH_HOUR 点（默认 9 点）推当天到期/过期未完成待办
const todoPusher = new TodoReminderPusher(
  client,
  (userId, text) => replyQueue.enqueue(() => bot.send(userId, text).then(() => undefined)),
  { storageDir: cfg.storageDir, pushHour: Number(process.env.TODO_PUSH_HOUR ?? 9) },
)

const loginCallbacks = {
  onQrUrl: (url: string) => {
    console.log('\n请用微信扫码绑定（或在手机上打开链接）：\n' + url + '\n')
    qrcode.generate(url, { small: true })
  },
  onScanned: () => console.log('已扫码，请在手机上确认…'),
  onExpired: () => console.log('二维码已过期，正在刷新…'),
}

// ---- 状态心跳：把真实登录状态上报后端，/health?probe=bridge 如实暴露 ----
const HEARTBEAT_INTERVAL_MS = 60_000
type BridgeStatus = 'starting' | 'waiting_scan' | 'online'
let bridgeStatus: BridgeStatus = 'starting'
let bridgeDetail: string | undefined

function setBridgeStatus(status: BridgeStatus, detail?: string): void {
  bridgeStatus = status
  bridgeDetail = detail
  void sendHeartbeat()
}

async function sendHeartbeat(): Promise<void> {
  try {
    await client.heartbeat(bridgeStatus, bridgeDetail)
  } catch (err) {
    console.warn('[suinian] 心跳上报失败：', err instanceof Error ? err.message : err)
  }
}

setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS).unref?.()

bot.on('session:expired', () => {
  console.warn('[suinian] iLink 会话过期，SDK 正在自动重新登录…')
  setBridgeStatus('waiting_scan', 'session expired')
})
bot.on('session:restored', () => {
  console.log('[suinian] 会话已恢复')
  setBridgeStatus('online')
})
bot.on('error', (err: unknown) => console.error('[suinian] bot error:', err))

bot.onMessage(async (msg: IncomingMessage) => {
  try {
    reviewPusher.trackUser(msg.userId)
    todoPusher.trackUser(msg.userId)
    await bot.sendTyping(msg.userId)
    const normalized = await normalize(msg)
    const reply = await handleMessage(client, normalized)
    await replyQueue.enqueue(() => bot.reply(msg, reply).then(() => undefined))
  } catch (err) {
    if (err instanceof FatalApiError) {
      console.error('[suinian] 致命错误：', err.message)
      await replyQueue.enqueue(() =>
        bot.reply(msg, '碎念后端配置有误（token 无效），请管理员检查 SUINIAN_TOKEN。').then(() => undefined),
      )
      return
    }
    console.error('[suinian] 处理消息失败：', err)
  }
})

/** 微信消息 → 内部规整结构；有媒体时下载内容（小文件内联 base64 给后端存 R2） */
async function normalize(msg: IncomingMessage): Promise<NormalizedMessage> {
  const out: NormalizedMessage = {
    userId: msg.userId,
    messageId: msg.raw?.message_id != null ? String(msg.raw.message_id) : undefined,
    text: msg.text ?? '',
    type: msg.type,
    timestamp: msg.timestamp,
  }
  if (msg.type !== 'text') {
    try {
      const media = await bot.download(msg)
      if (media) {
        out.media = [
          {
            // 语音经 SDK 自动 silk→wav 转码（需安装 silk-wasm），format 标记实际格式
            mime: media.format === 'wav' ? 'audio/wav' : guessMime(msg.type, media.fileName),
            size: media.data.length,
            fileName: media.fileName,
            data: media.data,
          },
        ]
      }
    } catch (err) {
      console.warn('[suinian] 媒体下载失败（继续以元数据入库）：', err)
    }
  }
  return out
}

function guessMime(type: NormalizedMessage['type'], fileName?: string): string {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      mp3: 'audio/mpeg', mp4: 'video/mp4', silk: 'audio/silk',
    }
    if (ext && map[ext]) return map[ext]
  }
  switch (type) {
    case 'image': return 'image/jpeg'
    case 'voice': return 'audio/silk'
    case 'video': return 'video/mp4'
    default: return 'application/octet-stream'
  }
}

/** 扫码可能超过单轮二维码有效期（约 60s），失败自动换新码重试 */
async function loginWithRetry(maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.login({ callbacks: loginCallbacks })
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      console.warn(`[suinian] 登录未完成（第 ${attempt} 次，可能是二维码超时未扫），正在换新二维码…`)
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

/**
 * 登录直到成功：登录失效需要人工扫码，进程不退出（退出只会让 systemd 无限
 * 重启刷日志），而是上报 waiting_scan 心跳并按递增间隔刷新二维码等待扫码。
 */
async function loginUntilSuccess(): Promise<void> {
  for (let round = 1; ; round++) {
    try {
      await loginWithRetry()
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const delayMs = Math.min(60_000 * 2 ** Math.min(round - 1, 4), 16 * 60_000)
      setBridgeStatus('waiting_scan', `login attempt round ${round} failed: ${msg}`)
      console.warn(`[suinian] 登录未完成（第 ${round} 轮：${msg}），等待扫码；${Math.round(delayMs / 1000)}s 后刷新二维码（ssh 后运行 suinian-qr 查看）`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function main() {
  console.log('[suinian] wechat bridge 启动，后端：' + cfg.apiUrl)
  setBridgeStatus('starting')
  await loginUntilSuccess()
  await bot.start()
  reviewPusher.start()
  todoPusher.start()
  setBridgeStatus('online')
  console.log('[suinian] 已上线，等待微信消息…（? 开头问答，其余入库；每日 ' + reviewPusher.pushHour + ' 点推今日回顾、' + todoPusher.pushHour + ' 点推待办提醒）')
}

main().catch((err) => {
  console.error('[suinian] 启动失败：', err)
  process.exit(1)
})
