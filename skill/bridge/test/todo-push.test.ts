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
