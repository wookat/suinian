import type {
  NotePatch,
  AskResponse,
  CreateNotePayload,
  Note,
  NotesQuery,
  NotesResponse,
  ReportsResponse,
  Thread,
  ThreadDetail,
  ThreadsResponse,
  StatsResponse,
  TodayReviewResponse,
  WeeklyReport,
} from "./types"

const MOCK_KEY = "suinian.mock.notes.v2"

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString()
}

const seedNotes: Note[] = [
  {
    id: "n-001",
    user_id: "u-1",
    source: "web",
    raw_type: "text",
    content:
      "碎片笔记产品的核心不是记录，而是「找得到 + 有人替你整理」。AI 分拣 + 线索聚类可能是差异化的关键。",
    url: null,
    url_title: null,
    url_summary: null,
    title: "碎片笔记的差异化：分拣与线索",
    category: "idea",
    tags: ["产品思考", "碎念", "AI"],
    thread_id: "t-1",
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(2),
    updated_at: hoursAgo(2),
  },
  {
    id: "n-002",
    user_id: "u-1",
    source: "wechat",
    raw_type: "link",
    content: "https://help.flomoapp.com/thought/",
    url: "https://help.flomoapp.com/thought/",
    url_title: "flomo 101：持续不断记录，意义自然浮现",
    url_summary:
      "flomo 的产品理念：不追求排版与整理，鼓励持续记录卡片式想法，通过回顾与随机漫步让旧想法重新浮现。",
    category: "collect",
    tags: ["竞品", "flomo", "笔记"],
    thread_id: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(5),
    updated_at: hoursAgo(5),
  },
  {
    id: "n-003",
    user_id: "u-1",
    source: "android",
    raw_type: "text",
    content: "周五前把碎念 Web 端 R1 的 PR 提交，附上手机和桌面截图",
    url: null,
    url_title: null,
    url_summary: null,
    title: "提交碎念 Web R1 PR",
    category: "todo",
    tags: ["碎念", "开发"],
    thread_id: null,
    is_sensitive: 0,
    todo_due: hoursAgo(-48),
    todo_done: 0,
    created_at: hoursAgo(8),
    updated_at: hoursAgo(8),
  },
  {
    id: "n-004",
    user_id: "u-1",
    source: "wechat",
    raw_type: "text",
    content: "家里 WiFi 路由器管理地址 192.168.31.1，固件升级入口在「常用设置-系统状态」",
    url: null,
    url_title: null,
    url_summary: null,
    title: "家里路由器管理入口",
    category: "data",
    tags: ["家庭", "网络"],
    thread_id: null,
    is_sensitive: 1,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(26),
    updated_at: hoursAgo(26),
  },
  {
    id: "n-005",
    user_id: "u-1",
    source: "web",
    raw_type: "text",
    content:
      "如果把微信文件传输助手当收件箱的人有几亿，那「入口最近」这件事本身就是最大的护城河。ClawBot 接管微信入口值得押注。",
    url: null,
    url_title: null,
    url_summary: null,
    category: "idea",
    tags: ["产品思考", "微信", "入口"],
    thread_id: "t-1",
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(30),
    updated_at: hoursAgo(30),
  },
  {
    id: "n-006",
    user_id: "u-1",
    source: "android",
    raw_type: "link",
    content: "https://mymind.com/",
    url: "https://mymind.com/",
    url_title: "MyMind — A new mind for your memories",
    url_summary:
      "MyMind 用 AI 自动打标签、无文件夹的私人收藏库，$12/月，中文支持弱，没有 Android 深度优化。",
    category: "collect",
    tags: ["竞品", "MyMind"],
    thread_id: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(50),
    updated_at: hoursAgo(50),
  },
  {
    id: "n-007",
    user_id: "u-1",
    source: "wechat",
    raw_type: "text",
    content: "买猫粮：渴望六种鱼 1.8kg，比价京东/淘宝",
    url: null,
    url_title: null,
    url_summary: null,
    category: "todo",
    tags: ["生活", "购物"],
    thread_id: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 1,
    created_at: hoursAgo(72),
    updated_at: hoursAgo(20),
  },
  {
    id: "n-008",
    user_id: "u-1",
    source: "web",
    raw_type: "text",
    content:
      "周报如果只是流水账没人看。应该回答「这周你在想什么」——把想法碎片聚类后讲成一个故事，才有回看价值。",
    url: null,
    url_title: null,
    url_summary: null,
    category: "idea",
    tags: ["产品思考", "周报"],
    thread_id: "t-2",
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: hoursAgo(96),
    updated_at: hoursAgo(96),
  },
]

function loadMockNotes(): Note[] {
  try {
    const raw = localStorage.getItem(MOCK_KEY)
    if (raw) return JSON.parse(raw) as Note[]
  } catch {
    // ignore
  }
  return [...seedNotes]
}

function saveMockNotes(notes: Note[]) {
  localStorage.setItem(MOCK_KEY, JSON.stringify(notes))
}

function delay(ms = 250): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function mockGetNotes(query: NotesQuery): Promise<NotesResponse> {
  await delay()
  let notes = loadMockNotes()
  if (query.category) notes = notes.filter((n) => n.category === query.category)
  if (query.tag) notes = notes.filter((n) => n.tags.includes(query.tag!))
  if (query.q) {
    const q = query.q.toLowerCase()
    notes = notes.filter(
      (n) =>
        n.content.toLowerCase().includes(q) ||
        (n.url_title ?? "").toLowerCase().includes(q) ||
        (n.url_summary ?? "").toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }
  notes.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return { notes, cursor: null }
}

const URL_RE = /^https?:\/\/\S+$/i

export async function mockCreateNote(payload: CreateNotePayload): Promise<Note> {
  await delay()
  const now = new Date().toISOString()
  const isLink = payload.url != null || URL_RE.test(payload.content.trim())
  const id = `n-${Date.now()}`
  const note: Note = {
    id,
    user_id: "u-1",
    source: payload.source,
    raw_type: isLink ? "link" : payload.raw_type,
    content: payload.content,
    url: payload.url ?? (isLink ? payload.content.trim() : null),
    url_title: null,
    url_summary: null,
    title: null,
    category: null,
    tags: [],
    thread_id: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: now,
    updated_at: now,
  }
  const notes = loadMockNotes()
  notes.unshift(note)
  saveMockNotes(notes)
  // Simulate the async AI triage pipeline backfilling category/tags
  setTimeout(() => {
    const all = loadMockNotes()
    const idx = all.findIndex((n) => n.id === id)
    if (idx === -1) return
    all[idx] = {
      ...all[idx],
      category: isLink ? "collect" : "idea",
      tags: isLink ? ["收藏"] : ["随手记"],
      title: all[idx].content.slice(0, 18) || null,
      updated_at: new Date().toISOString(),
    }
    saveMockNotes(all)
  }, 2500)
  return note
}

export async function mockGetNote(id: string): Promise<Note | null> {
  await delay(120)
  return loadMockNotes().find((n) => n.id === id) ?? null
}

export async function mockDeleteNote(id: string): Promise<void> {
  await delay(120)
  saveMockNotes(loadMockNotes().filter((n) => n.id !== id))
}

export async function mockPatchNote(
  id: string,
  patch: NotePatch,
): Promise<Note> {
  await delay(120)
  const notes = loadMockNotes()
  const idx = notes.findIndex((n) => n.id === id)
  if (idx === -1) throw new Error("note not found")
  notes[idx] = { ...notes[idx], ...patch, updated_at: new Date().toISOString() }
  saveMockNotes(notes)
  return notes[idx]
}

export async function mockAsk(question: string): Promise<AskResponse> {
  await delay(700)
  const notes = loadMockNotes()
  const words = question
    .toLowerCase()
    .split(/[\s,，。？?!]+/)
    .filter((w) => w.length >= 2)
  const scored = notes
    .map((n) => {
      const text = `${n.content} ${n.url_title ?? ""} ${n.tags.join(" ")}`.toLowerCase()
      const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0)
      return { n, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const hits = scored.map((x) => x.n)
  const answer =
    hits.length > 0
      ? `（Mock 回答）根据你的笔记，与「${question}」相关的记录有 ${hits.length} 条。其中最相关的一条提到：「${hits[0].content.slice(0, 60)}…」。连接真实后端后，这里会由 DeepSeek 结合检索结果生成完整回答。`
      : `（Mock 回答）没有在你的笔记里找到与「${question}」直接相关的内容。连接真实后端后会使用向量召回获得更好的效果。`
  return {
    answer,
    references: hits.map((n, i) => ({ index: i + 1, note_id: n.id })),
    notes: hits,
  }
}

const seedThreads: Thread[] = [
  {
    id: "t-1",
    user_id: "u-1",
    title: "碎片笔记产品的差异化路径",
    summary:
      "围绕「AI 分拣 + 线索聚类 + 微信入口」的一组思考：找得到比记得多重要，入口最近是最大护城河。",
    note_count: 2,
    updated_at: hoursAgo(2),
  },
  {
    id: "t-2",
    user_id: "u-1",
    title: "周报应该讲故事而不是流水账",
    summary: "周报的价值在于回答「这周你在想什么」，把碎片聚类后讲成一个故事。",
    note_count: 1,
    updated_at: hoursAgo(96),
  },
]

export async function mockGetThreads(): Promise<ThreadsResponse> {
  await delay()
  return { threads: seedThreads }
}

export async function mockGetThread(id: string): Promise<ThreadDetail> {
  await delay()
  const thread = seedThreads.find((t) => t.id === id)
  if (!thread) throw new Error("thread not found")
  const notes = loadMockNotes()
    .filter((n) => n.thread_id === id)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  return { ...thread, notes }
}

const seedReports: WeeklyReport[] = [
  {
    id: "r-1",
    user_id: "u-1",
    week_start: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
    content_md: `# 本周思考报告

## 你在想什么

这周你的想法主要集中在**碎片笔记产品的差异化**上：

- 核心不是记录，而是「找得到 + 有人替你整理」
- 微信入口的「距离优势」可能是最大护城河
- 周报应该讲故事，而不是流水账

## 待办进展

- 完成 1 项：买猫粮
- 逾期 1 项：提交碎念 Web R1 PR

## 收藏了什么

flomo 的产品理念、MyMind 的 AI 标签方案，都值得回看。`,
    created_at: hoursAgo(96),
  },
]

export async function mockGetReports(): Promise<ReportsResponse> {
  await delay()
  return { reports: seedReports }
}

export async function mockGetReport(id: string): Promise<WeeklyReport> {
  await delay(120)
  const report = seedReports.find((r) => r.id === id)
  if (!report) throw new Error("report not found")
  return report
}

export async function mockGenerateReport(): Promise<WeeklyReport> {
  await delay(600)
  return seedReports[0]
}

export async function mockGetStats(): Promise<StatsResponse> {
  await delay(120)
  const notes = loadMockNotes().filter((n) => !n.tags.includes("示例"))
  const dailyMap = new Map<string, number>()
  const catMap = new Map<string, number>()
  const srcMap = new Map<string, number>()
  const tagMap = new Map<string, number>()
  for (const n of notes) {
    const d = n.created_at.slice(0, 10)
    dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1)
    catMap.set(n.category ?? "pending", (catMap.get(n.category ?? "pending") ?? 0) + 1)
    srcMap.set(n.source, (srcMap.get(n.source) ?? 0) + 1)
    if (n.is_sensitive !== 1) for (const t of n.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
  }
  const byCount = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const today = new Date().toISOString().slice(0, 10)
  return {
    total_notes: notes.length,
    thread_count: 2,
    active_days: dailyMap.size,
    daily: [...dailyMap.entries()].sort().map(([date, count]) => ({ date, count })),
    streak: { current: dailyMap.has(today) ? 1 : 0, longest: 3 },
    categories: byCount(catMap).map(([category, count]) => ({ category, count })),
    sources: byCount(srcMap).map(([source, count]) => ({ source, count })),
    top_tags: byCount(tagMap)
      .slice(0, 12)
      .map(([tag, count]) => ({ tag, count })),
  }
}

export async function mockGetRandomNote(): Promise<Note | null> {
  await delay(120)
  const notes = loadMockNotes().filter((n) => n.is_sensitive !== 1 && !n.tags.includes("示例"))
  if (notes.length === 0) return null
  return notes[Math.floor(Math.random() * notes.length)]
}

export async function mockGetTodayReview(): Promise<TodayReviewResponse> {
  await delay(120)
  const notes = loadMockNotes().filter((n) => n.is_sensitive !== 1)
  const pick = notes[notes.length - 1] ?? notes[0]
  return {
    date: new Date().toISOString().slice(0, 10),
    items: pick
      ? [
          {
            id: "rv-1",
            kind: "revisit",
            kind_label: "值得回看",
            comment: "这条记了很久没再翻过，也许正是重新审视它的好时机。",
            note: pick,
          },
        ]
      : [],
  }
}
