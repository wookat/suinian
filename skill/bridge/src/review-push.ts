import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SuinianClient, TodayReviewResponse } from './client.js'

/**
 * 每日「今日回顾」微信推送：在上海时间的固定小时，把后端 /api/review/today
 * 的第一条回顾推给所有已绑定（曾给 bot 发过消息）的微信用户。
 * ClawBot 的 send() 依赖用户先发过消息产生 context_token，因此这里只推送
 * 见过的用户，并把名单持久化到 storageDir 以便重启后继续。
 */

export interface ReviewPushState {
  /** 曾给 bot 发过消息的微信用户 ID（有 context_token，可主动推送） */
  users: string[]
  /** 最近一次成功推送的上海日期（YYYY-MM-DD），防止一天重复推 */
  lastPushedDate?: string
}

export function shanghaiDate(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

export function shanghaiHour(now: Date = new Date()): number {
  return new Date(now.getTime() + 8 * 3600 * 1000).getUTCHours()
}

/** 把今日回顾拼成一条微信消息文案；无内容返回 null（当天不推送） */
export function formatReviewMessage(review: TodayReviewResponse): string | null {
  const item = review.items[0]
  if (!item) return null
  const date = item.note.created_at.slice(0, 10)
  const body = (item.note.title || item.note.content).slice(0, 200)
  const lines = [`【今日回顾 · ${item.kind_label}】`, '', body, '', `—— 记于 ${date}`]
  if (item.comment) lines.push(item.comment)
  lines.push('', '回复 ? 开头可继续追问，打开 suinian.zalize.com 查看更多')
  return lines.join('\n')
}

export class DailyReviewPusher {
  private state: ReviewPushState
  private readonly stateFile: string
  private timer?: NodeJS.Timeout

  constructor(
    private readonly client: Pick<SuinianClient, 'reviewToday' | 'preferences'>,
    private readonly send: (userId: string, text: string) => Promise<void>,
    opts: { storageDir: string; pushHour?: number },
  ) {
    this.pushHour = opts.pushHour ?? 8
    this.stateFile = join(opts.storageDir, 'review-push.json')
    this.state = this.loadState()
  }

  readonly pushHour: number

  /** 记录见过的用户（有 context_token 才能主动 send） */
  trackUser(userId: string): void {
    if (this.state.users.includes(userId)) return
    this.state.users.push(userId)
    this.saveState()
  }

  /** 每分钟检查一次：到点且当天未推过 → 推送 */
  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async tick(now: Date = new Date()): Promise<boolean> {
    const today = shanghaiDate(now)
    if (this.state.lastPushedDate === today) return false
    if (shanghaiHour(now) < this.pushHour) return false
    if (this.state.users.length === 0) return false
    try {
      const prefs = await this.client.preferences().catch(() => null)
      if (prefs && !prefs.daily_review_push) {
        // 用户关掉了每日回顾推送：当天标记完成，不发消息
        this.state.lastPushedDate = today
        this.saveState()
        return false
      }
      const review = await this.client.reviewToday()
      const message = formatReviewMessage(review)
      if (message) {
        for (const userId of this.state.users) {
          try {
            await this.send(userId, message)
          } catch (err) {
            console.warn(`[suinian] 回顾推送失败 user=${userId}：`, err)
          }
        }
      }
      // 无回顾内容的日子也标记完成，避免整天空轮询后端
      this.state.lastPushedDate = today
      this.saveState()
      return message !== null
    } catch (err) {
      console.warn('[suinian] 获取今日回顾失败，稍后重试：', err)
      return false
    }
  }

  private loadState(): ReviewPushState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as ReviewPushState
      return { users: Array.isArray(raw.users) ? raw.users : [], lastPushedDate: raw.lastPushedDate }
    } catch {
      return { users: [] }
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.state))
    } catch (err) {
      console.warn('[suinian] 回顾推送状态保存失败：', err)
    }
  }
}
