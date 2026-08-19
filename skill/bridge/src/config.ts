export interface BridgeConfig {
  apiUrl: string
  token: string
  /** 专用心跳凭证（后端 BRIDGE_TOKEN，R194 P2-5）；未配时心跳会被后端 401 拒绝 */
  bridgeToken?: string
  storageDir: string
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  /** 微信 iLink 侧限流：两次回复之间的最小间隔（毫秒），默认 3000 */
  replyIntervalMs: number
  /** 后端请求超时（毫秒） */
  requestTimeoutMs: number
  /** 后端请求失败重试次数 */
  maxRetries: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const apiUrl = env.SUINIAN_API_URL
  const token = env.SUINIAN_TOKEN
  if (!apiUrl) throw new Error('缺少环境变量 SUINIAN_API_URL（后端地址，例如 https://suinian-api.zalize.com）')
  if (!token) throw new Error('缺少环境变量 SUINIAN_TOKEN（后端 Bearer token）')
  if (!env.SUINIAN_BRIDGE_TOKEN) {
    console.warn('[config] 未配置 SUINIAN_BRIDGE_TOKEN（专用心跳凭证），心跳上报将被后端拒绝')
  }
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    token,
    bridgeToken: env.SUINIAN_BRIDGE_TOKEN,
    storageDir: env.WECHATBOT_STORAGE_DIR ?? `${env.HOME ?? '.'}/.wechatbot`,
    logLevel: (env.LOG_LEVEL as BridgeConfig['logLevel']) ?? 'info',
    replyIntervalMs: Number(env.REPLY_INTERVAL_MS ?? 3000),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 30000),
    maxRetries: Number(env.MAX_RETRIES ?? 3),
  }
}
