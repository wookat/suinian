import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoReminderPusher, formatTodoMessage } from '../src/todo-push.js'
import type { TodayTodosResponse } from '../src/client.js'

const todos: TodayTodosResponse = {
  date: '2026-08-07',
  items: [
    { id: 't-1', title: null, content: '交季度报告', todo_due: '2026-08-06', overdue: true },
    { id: 't-2', title: '给客户回电话', content: '给客户回电话，确认合同细节', todo_due: '2026-08-07T15:00', overdue: false },
  ],
}

describe('formatTodoMessage', () => {
  it('lists todos with overdue markers and due times', () => {
    const msg = formatTodoMessage(todos)!
    expect(msg).toContain('【今日待办 · 2026-08-07】')
    expect(msg).toContain('⚠️已过期 交季度报告')
    expect(msg).toContain('给客户回电话（2026-08-07 15:00）')
  })
  it('returns null when there are no todos', () => {
    expect(formatTodoMessage({ date: '2026-08-07', items: [] })).toBeNull()
  })
  // R385：积压逾期多于 10 行时当天到期的优先列出，余下行给最近的逾期项；「还有 N 条」按服务端逾期总数
  it('lists due-today items first, then the most recent overdue, and counts the rest from overdue_total', () => {
    // 48 条逾期按到期升序（与服务端 items 一致）：逾期 0 最早、逾期 47 最近（09-08）
    const overdue = Array.from({ length: 48 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 8, 8) - (47 - i) * 86400000).toISOString().slice(0, 10)
      return { id: `o-${i}`, title: null, content: `逾期 ${i}`, todo_due: `${day}T09:00:00+08:00`, overdue: true }
    })
    const msg = formatTodoMessage({
      date: '2026-09-10',
      overdue_total: 52,
      items: [
        ...overdue,
        { id: 'a', title: '今天 A', content: '', todo_due: '2026-09-10T09:00:00+08:00', overdue: false },
        { id: 'b', title: '今天 B', content: '', todo_due: '2026-09-10T18:00:00+08:00', overdue: false },
      ],
    })!
    const body = msg.split('\n').slice(2, 12)
    expect(body[0]).toBe('· 今天 A（2026-09-10 09:00）')
    expect(body[1]).toBe('· 今天 B（2026-09-10 18:00）')
    expect(body[2]).toBe('⚠️已过期 逾期 40（2026-09-01 09:00）')
    expect(body[9]).toBe('⚠️已过期 逾期 47（2026-09-08 09:00）')
    // 2 今天 + 52 逾期 = 54 条，列出 10 条
    expect(msg).toContain('…还有 44 条')
    expect(msg).not.toContain('逾期 39')
  })
})

function makePusher(sent: { userId: string; text: string }[], todoReminderPush = true) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-push-'))
  return new TodoReminderPusher(
    {
      todosToday: async () => todos,
      preferences: async () => ({ daily_review_push: true, todo_reminder_push: todoReminderPush }),
    },
    async (userId, text) => {
      sent.push({ userId, text })
    },
    { storageDir: dir, pushHour: 9 },
  )
}

describe('TodoReminderPusher.tick', () => {
  // 01:30 UTC = 09:30 Shanghai (past the default 9 o'clock push hour)
  const pushTime = new Date('2026-08-07T01:30:00Z')

  it('pushes the todo list once per Shanghai day to tracked users', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent)
    pusher.trackUser('wx-1')
    pusher.trackUser('wx-2')
    expect(await pusher.tick(pushTime)).toBe(true)
    expect(sent.map((s) => s.userId)).toEqual(['wx-1', 'wx-2'])
    expect(await pusher.tick(pushTime)).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it('does not push before the push hour', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent)
    pusher.trackUser('wx-1')
    // 00:00 UTC = 08:00 Shanghai, before 9 o'clock
    expect(await pusher.tick(new Date('2026-08-07T00:00:00Z'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('skips the day silently when the todo reminder preference is off', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent, false)
    pusher.trackUser('wx-1')
    expect(await pusher.tick(pushTime)).toBe(false)
    expect(sent).toHaveLength(0)
    expect(await pusher.tick(pushTime)).toBe(false)
  })
})
