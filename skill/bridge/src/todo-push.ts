import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SuinianClient, TodayTodosResponse } from './client.js'
import { shanghaiDate, shanghaiHour } from './review-push.js'

/**
 * 每日待办提醒微信推送：上海时间上午的固定小时，把 /api/todos/today
 * 的当天到期 + 过期未完成待办清单推给所有已绑定的微信用户。
 * 与每日回顾推送共用「见过的用户才能主动 send」约束，各自维护状态文件。
 */

export interface TodoPushState {
  users: string[]
  lastPushedDate?: string
}

const MAX_TODO_LINES = 10

/** 把当天待办拼成一条微信消息文案；无待办返回 null（当天不推送） */
export function formatTodoMessage(todos: TodayTodosResponse): string | null {
  if (todos.items.length === 0) return null
  const lines = [`【今日待办 · ${todos.date}】`, '']
  // 当天到期的优先列出，余下行数给最近的逾期项（items 里逾期项按到期升序，最近的在末尾）
  const dueToday = todos.items.filter((t) => !t.overdue)
  const overdue = todos.items.filter((t) => t.overdue)
  const shownToday = dueToday.slice(0, MAX_TODO_LINES)
  const shownOverdue = overdue.slice(Math.max(0, overdue.length - (MAX_TODO_LINES - shownToday.length)))
  for (const t of [...shownToday, ...shownOverdue]) {
    const text = (t.title || t.content).replace(/\s+/g, ' ').slice(0, 50)
    const due = t.todo_due ? t.todo_due.replace('T', ' ').slice(0, 16) : ''
    lines.push(`${t.overdue ? '⚠️已过期' : '·'} ${text}${due ? `（${due}）` : ''}`)
  }
  const total = dueToday.length + Math.max(todos.overdue_total ?? 0, overdue.length)
  const shown = shownToday.length + shownOverdue.length
  if (total > shown) lines.push(`…还有 ${total - shown} 条`)
  lines.push('', '完成后可在 suinian.zalize.com 勾掉它们')
  return lines.join('\n')
}

export class TodoReminderPusher {
  private state: TodoPushState
  private readonly stateFile: string
  private timer?: NodeJS.Timeout

  constructor(
    private readonly client: Pick<SuinianClient, 'todosToday' | 'preferences'>,
    private readonly send: (userId: string, text: string) => Promise<void>,
    opts: { storageDir: string; pushHour?: number },
  ) {
    this.pushHour = opts.pushHour ?? 9
    this.stateFile = join(opts.storageDir, 'todo-push.json')
    this.state = this.loadState()
  }

  readonly pushHour: number

  trackUser(userId: string): void {
    if (this.state.users.includes(userId)) return
    this.state.users.push(userId)
    this.saveState()
  }

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
      if (prefs && !prefs.todo_reminder_push) {
        // 用户关掉了待办提醒推送：当天标记完成，不发消息
        this.state.lastPushedDate = today
        this.saveState()
        return false
      }
      const todos = await this.client.todosToday()
      const message = formatTodoMessage(todos)
      if (message) {
        for (const userId of this.state.users) {
          try {
            await this.send(userId, message)
          } catch (err) {
            console.warn(`[suinian] 待办提醒推送失败 user=${userId}：`, err)
          }
        }
      }
      // 无待办的日子也标记完成，避免整天空轮询后端
      this.state.lastPushedDate = today
      this.saveState()
      return message !== null
    } catch (err) {
      console.warn('[suinian] 获取今日待办失败，稍后重试：', err)
      return false
    }
  }

  private loadState(): TodoPushState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as TodoPushState
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
      console.warn('[suinian] 待办提醒状态保存失败：', err)
    }
  }
}
