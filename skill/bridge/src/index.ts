import { WeChatBot, type IncomingMessage } from '@wechatbot/wechatbot'
import qrcode from 'qrcode-terminal'
import { loadConfig } from './config.js'
import { SuinianClient, FatalApiError } from './client.js'
import { handleMessage } from './handler.js'
import { ReplyQueue } from './queue.js'
import type { NormalizedMessage } from './payload.js'

const cfg = loadConfig()
const client = new SuinianClient(cfg)
const replyQueue = new ReplyQueue(cfg.replyIntervalMs)

const bot = new WeChatBot({
  storageDir: cfg.storageDir,
  logLevel: cfg.logLevel,
  loginCallbacks: {
    onQrUrl: (url: string) => {
      console.log('\n请用微信扫码绑定（或在手机上打开链接）：\n' + url + '\n')
      qrcode.generate(url, { small: true })
    },
    onScanned: () => console.log('已扫码，请在手机上确认…'),
    onExpired: () => console.log('二维码已过期，正在刷新…'),
  },
})

bot.on('session:expired', () => console.warn('[suinian] iLink 会话过期，SDK 正在自动重新登录…'))
bot.on('session:restored', () => console.log('[suinian] 会话已恢复'))
bot.on('error', (err: unknown) => console.error('[suinian] bot error:', err))

bot.onMessage(async (msg: IncomingMessage) => {
  try {
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
            mime: guessMime(msg.type, media.fileName),
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

async function main() {
  console.log('[suinian] wechat bridge 启动，后端：' + cfg.apiUrl)
  await bot.login()
  await bot.start()
  console.log('[suinian] 已上线，等待微信消息…（? 开头问答，其余入库）')
}

main().catch((err) => {
  console.error('[suinian] 启动失败：', err)
  process.exit(1)
})
