/**
 * 串行回复队列：微信 iLink 侧实测约「3 秒 1 条」的下行限流
 * （见 skill/docs/clawbot-limits.md），把所有出站回复排队并保持最小间隔。
 */
export class ReplyQueue {
  private chain: Promise<void> = Promise.resolve()
  private lastSentAt = 0

  constructor(private readonly minIntervalMs: number) {}

  enqueue(task: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(async () => {
      const wait = this.lastSentAt + this.minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        await task()
      } finally {
        this.lastSentAt = Date.now()
      }
    })
    return this.chain
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
