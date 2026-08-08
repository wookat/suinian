import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyReviewPusher, formatReviewMessage, shanghaiDate, shanghaiHour } from '../src/review-push.js'
import type { TodayReviewResponse } from '../src/client.js'

const review: TodayReviewResponse = {
  date: '2026-08-07',
  items: [
    {
      id: 'rv-1',
      kind: 'year_ago',
      kind_label: '一年前的今天',
      comment: '当时的判断现在应验了吗？',
      note: { id: 'n-1', title: '碎片笔记的差异化', content: '内容', created_at: '2025-08-07 02:00:00' },
    },
  ],
}

describe('formatReviewMessage', () => {
  it('formats the first item with kind label, date and comment', () => {
    const msg = formatReviewMessage(review)!
    expect(msg).toContain('【今日回顾 · 一年前的今天】')
    expect(msg).toContain('碎片笔记的差异化')
    expect(msg).toContain('记于 2025-08-07')
    expect(msg).toContain('当时的判断现在应验了吗？')
  })
  it('returns null when there is nothing to review', () => {
    expect(formatReviewMessage({ date: '2026-08-07', items: [] })).toBeNull()
  })
})

describe('shanghai time helpers', () => {
  it('computes Shanghai date and hour from UTC', () => {
    expect(shanghaiDate(new Date('2026-08-06T20:00:00Z'))).toBe('2026-08-07')
    expect(shanghaiHour(new Date('2026-08-07T00:00:00Z'))).toBe(8)
  })
})

function makePusher(sent: { userId: string; text: string }[], pushHour = 8, dailyReviewPush = true) {
  const dir = mkdtempSync(join(tmpdir(), 'review-push-'))
  return new DailyReviewPusher(
    {
      reviewToday: async () => review,
      preferences: async () => ({ daily_review_push: dailyReviewPush, todo_reminder_push: true }),
    },
    async (userId, text) => {
      sent.push({ userId, text })
    },
    { storageDir: dir, pushHour },
  )
}

describe('DailyReviewPusher.tick', () => {
  // 00:30 UTC = 08:30 Shanghai (past the default 8 o'clock push hour)
  const pushTime = new Date('2026-08-07T00:30:00Z')

  it('pushes once per Shanghai day to tracked users', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent)
    pusher.trackUser('wx-1')
    pusher.trackUser('wx-2')
    expect(await pusher.tick(pushTime)).toBe(true)
    expect(sent.map((s) => s.userId)).toEqual(['wx-1', 'wx-2'])
    // second tick the same day: no duplicate push
    expect(await pusher.tick(pushTime)).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it('does not push before the push hour or without tracked users', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent)
    pusher.trackUser('wx-1')
    // 23:00 UTC previous day = 07:00 Shanghai, before 8 o'clock
    expect(await pusher.tick(new Date('2026-08-06T23:00:00Z'))).toBe(false)
    const noUsers = makePusher(sent)
    expect(await noUsers.tick(pushTime)).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('skips the day silently when the daily review push preference is off', async () => {
    const sent: { userId: string; text: string }[] = []
    const pusher = makePusher(sent, 8, false)
    pusher.trackUser('wx-1')
    expect(await pusher.tick(pushTime)).toBe(false)
    expect(sent).toHaveLength(0)
    // marked done for the day: no retry loop
    expect(await pusher.tick(pushTime)).toBe(false)
  })
})
