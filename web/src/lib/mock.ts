import type {
  NotePatch,
  AskResponse,
  CreateNotePayload,
  Note,
  NotesQuery,
  NotesResponse,
  PrevCategory,
  ReportPeriod,
  ReportsResponse,
  Thread,
  ThreadDetail,
  ThreadsResponse,
  StatsResponse,
  TagCount,
  TodayReviewResponse,
  TrashNote,
  TrashResponse,
  WeeklyReport,
} from "./types"
import type { BatchBody, BatchResult } from "./api"

const MOCK_KEY = "suinian.mock.notes.v2"
const MOCK_TRASH_KEY = "suinian.mock.trash.v1"
const MOCK_REPORTS_KEY = "suinian.mock.reports.v1"
export const MOCK_TRASH_RETENTION_DAYS = 30

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

const seedIds = new Set(seedNotes.map((n) => n.id))

/** 用户在演示模式下自己记的笔记（去掉种子数据）：注册/登录后提示导入或清理（D-2） */
export function userDemoNotes(): Note[] {
  try {
    const raw = localStorage.getItem(MOCK_KEY)
    if (!raw) return []
    const notes = JSON.parse(raw) as Note[]
    return notes.filter((n) => !seedIds.has(n.id))
  } catch {
    return []
  }
}

/** 清空演示数据（整个 localStorage 键），同时消除明文滞留（D-3） */
export function clearDemoNotes(): void {
  try {
    localStorage.removeItem(MOCK_KEY)
    localStorage.removeItem(MOCK_TRASH_KEY)
    localStorage.removeItem(MOCK_REPORTS_KEY)
  } catch {
    // ignore
  }
}

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

/** 演示模式回收站：只保留未过保留期的软删笔记，过期项在读取时顺手清掉（对齐服务端到期彻底清理） */
function loadMockTrash(): TrashNote[] {
  let all: TrashNote[] = []
  try {
    const raw = localStorage.getItem(MOCK_TRASH_KEY)
    if (raw) all = JSON.parse(raw) as TrashNote[]
  } catch {
    all = []
  }
  const now = Date.now()
  const kept = all.filter((n) => !n.purge_at || Date.parse(n.purge_at) > now)
  if (kept.length !== all.length) saveMockTrash(kept)
  return kept
}

function saveMockTrash(notes: TrashNote[]) {
  localStorage.setItem(MOCK_TRASH_KEY, JSON.stringify(notes))
}

function delay(ms = 250): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 服务端 from/to 是 UTC "YYYY-MM-DD[ HH:MM:SS]"；纯日期按整天补齐，与 backend 同口径 */
function utcSqlToMs(s: string, endOfDay: boolean): number | null {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}:\d{2}))?$/)
  if (!m) return null
  const ms = Date.parse(`${m[1]}T${m[2] ?? (endOfDay ? "23:59:59" : "00:00:00")}Z`)
  return Number.isNaN(ms) ? null : ms
}

function filterMockNotes(all: Note[], query: NotesQuery): Note[] {
  let notes = all
  if (query.category) notes = notes.filter((n) => n.category === query.category)
  if (query.tag) notes = notes.filter((n) => n.tags.includes(query.tag!))
  if (query.source) notes = notes.filter((n) => n.source === query.source)
  const fromMs = query.from ? utcSqlToMs(query.from, false) : null
  const toMs = query.to ? utcSqlToMs(query.to, true) : null
  if (fromMs !== null) notes = notes.filter((n) => Date.parse(n.created_at) >= fromMs)
  if (toMs !== null) notes = notes.filter((n) => Date.parse(n.created_at) <= toMs)
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
  return notes
}

export async function mockGetNotes(query: NotesQuery): Promise<NotesResponse> {
  await delay()
  const notes = filterMockNotes(loadMockNotes(), query)
  notes.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  return { notes, cursor: null }
}

/** 标签面（与服务端 /api/tags 同口径）：敏感行的标签不进公开标签面，按次数降序、同次数按字典序 */
export async function mockGetTags(): Promise<TagCount[]> {
  await delay(100)
  const counts = new Map<string, number>()
  for (const n of loadMockNotes()) {
    if (n.is_sensitive === 1) continue
    for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }))
}

/**
 * 全局改写标签（与服务端 retagUser 同语义）：`to = null` 即移除；改到已有标签即合并（去重）；
 * 回收站行一并覆盖，恢复后与全局口径一致；只计实际含该标签的行。
 */
function retagMock(from: string, to: string | null): number {
  let affected = 0
  const retag = <T extends Note>(list: T[]) => {
    for (const n of list) {
      if (!n.tags.includes(from)) continue
      n.tags = [...new Set(n.tags.map((t) => (t === from ? to : t)).filter((t): t is string => t !== null))]
      n.updated_at = new Date().toISOString()
      affected++
    }
  }
  const notes = loadMockNotes()
  const trash = loadMockTrash()
  retag(notes)
  retag(trash)
  saveMockNotes(notes)
  saveMockTrash(trash)
  return affected
}

export async function mockRenameTag(from: string, to: string): Promise<number> {
  await delay(150)
  const f = from.trim()
  const t = to.trim()
  if (!f || !t) throw new Error("from/to required")
  if (t.length > 32) throw new Error("标签最长 32 个字符")
  if (f === t) return 0
  return retagMock(f, t)
}

export async function mockDeleteTag(tag: string): Promise<number> {
  await delay(150)
  const t = tag.trim()
  if (!t) throw new Error("tag required")
  return retagMock(t, null)
}

/**
 * 批量操作（与服务端 /api/notes/batch 同语义）：delete 软删进回收站并回传目标 ids；
 * add_tags / remove_tags 只回传实际变更的 ids；set_category 回传每条原分类快照 prev；
 * restore_categories 按 prev 逐条还原。target 传 ids 或筛选条件（筛选=全部匹配项）。
 */
export async function mockBatchNotes(
  body: BatchBody,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  await delay(150)
  const { action } = body
  const notes = loadMockNotes()
  if (action === "restore_categories") {
    const entries = body.entries ?? []
    const byId = new Map(entries.map((e) => [e.id, e]))
    const ids: string[] = []
    for (const n of notes) {
      const e = byId.get(n.id)
      if (!e) continue
      const { category: _c, ...rest } = n.meta?.manual_override ?? {}
      n.category = e.category as Note["category"]
      n.meta = { ...n.meta, manual_override: e.manual ? { ...rest, category: true } : rest }
      n.updated_at = new Date().toISOString()
      ids.push(n.id)
    }
    saveMockNotes(notes)
    onProgress?.(entries.length, entries.length)
    return { affected: ids.length, remaining: 0, ids }
  }
  const targetIds = body.filter ? filterMockNotes(notes, body.filter).map((n) => n.id) : (body.ids ?? [])
  const want = new Set(targetIds)
  onProgress?.(0, targetIds.length)
  if (action === "delete") {
    const hit = notes.filter((n) => want.has(n.id))
    if (hit.length) {
      const now = Date.now()
      const trash = loadMockTrash().filter((n) => !want.has(n.id))
      for (const note of hit) {
        trash.unshift({
          ...note,
          deleted_at: new Date(now).toISOString(),
          purge_at: new Date(now + MOCK_TRASH_RETENTION_DAYS * 86_400_000).toISOString(),
        })
      }
      saveMockTrash(trash)
      saveMockNotes(notes.filter((n) => !want.has(n.id)))
    }
    onProgress?.(targetIds.length, targetIds.length)
    return { affected: hit.length, remaining: 0, ids: targetIds }
  }
  const tags = body.tags ?? []
  const ids: string[] = []
  const prev: PrevCategory[] = []
  for (const n of notes) {
    if (!want.has(n.id)) continue
    if (action === "set_category") {
      prev.push({ id: n.id, category: n.category, manual: n.meta?.manual_override?.category === true })
      n.category = (body.category as Note["category"] | undefined) ?? n.category
      n.meta = { ...n.meta, manual_override: { ...n.meta?.manual_override, category: true } }
    } else {
      const next =
        action === "add_tags" ? [...new Set([...n.tags, ...tags])] : n.tags.filter((t) => !tags.includes(t))
      if (next.length === n.tags.length && next.every((t, i) => t === n.tags[i])) continue
      n.tags = next
      n.meta = { ...n.meta, manual_override: { ...n.meta?.manual_override, tags: true } }
    }
    n.updated_at = new Date().toISOString()
    ids.push(n.id)
  }
  saveMockNotes(notes)
  onProgress?.(targetIds.length, targetIds.length)
  return action === "set_category"
    ? { affected: ids.length, remaining: 0, ids, prev }
    : { affected: ids.length, remaining: 0, ids }
}

// 与 backend/src/linkmeta.ts URL_RE 同口径：正文中的第一个链接就是笔记的 url，不要求整条只有链接
const URL_RE = /https?:\/\/[^\s<>"'）)\]】，,；;]+/
const MOCK_TITLE_MAX = 20

/** 与 backend fallbackTitleFromUrl 同口径：域名 › 路径末两段，链接卡不会只剩一串裸 URL */
function mockLinkTitle(url: string): { title: string | null; site: string | null } {
  try {
    const u = new URL(url)
    let path = u.pathname.replace(/\/+$/, "")
    try {
      path = decodeURIComponent(path)
    } catch {
      /* keep raw path */
    }
    const tail = path.split("/").filter(Boolean).slice(-2).join("/")
    return { title: tail ? `${u.hostname} › ${tail}`.slice(0, 300) : u.hostname, site: u.hostname }
  } catch {
    return { title: null, site: null }
  }
}

/**
 * 演示版分拣标题：真实服务由模型出 ≤20 字的概括，这里只取首句——正文多于一句且首句不长才给，
 * 否则留空（卡片不会在正文上方重复一道截断的同文）。
 */
function mockTriageTitle(content: string): string | null {
  const text = content.replace(new RegExp(URL_RE.source, "g"), "").replace(/\s+/g, " ").trim()
  const parts = text.split(/[。！？!?；;\n]+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const first = parts[0].replace(/[，,]+$/, "")
  return first.length > 0 && first.length <= MOCK_TITLE_MAX ? first : null
}

export async function mockCreateNote(payload: CreateNotePayload): Promise<Note> {
  await delay()
  const now = new Date().toISOString()
  const content = payload.content
  const url = payload.url ?? content.match(URL_RE)?.[0] ?? null
  const bareLink = url != null && content.trim() === url
  const manualTags = (payload.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const skipTriage = payload.skip_triage === true
  const link = url ? mockLinkTitle(url) : null
  const id = `n-${Date.now()}`
  const note: Note = {
    id,
    user_id: "u-1",
    source: payload.source,
    raw_type: bareLink ? "link" : payload.raw_type,
    content,
    url,
    url_title: link?.title ?? null,
    url_summary: null,
    title: null,
    category: skipTriage ? "idea" : null,
    tags: manualTags,
    thread_id: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: null,
    created_at: now,
    updated_at: now,
    meta: link?.site ? { link_site: link.site } : null,
  }
  const notes = loadMockNotes()
  notes.unshift(note)
  saveMockNotes(notes)
  if (skipTriage) return note
  // Simulate the async AI triage pipeline backfilling category/tags/title;
  // manual #tags stay as typed (server locks them against AI rewrite)
  setTimeout(() => {
    const all = loadMockNotes()
    const idx = all.findIndex((n) => n.id === id)
    if (idx === -1) return
    all[idx] = {
      ...all[idx],
      category: bareLink ? "collect" : "idea",
      tags: manualTags.length > 0 ? manualTags : bareLink ? ["收藏"] : ["随手记"],
      title: bareLink ? null : mockTriageTitle(content),
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
  const notes = loadMockNotes()
  const note = notes.find((n) => n.id === id)
  saveMockNotes(notes.filter((n) => n.id !== id))
  if (!note) return
  const now = Date.now()
  const trash = loadMockTrash().filter((n) => n.id !== id)
  trash.unshift({
    ...note,
    deleted_at: new Date(now).toISOString(),
    purge_at: new Date(now + MOCK_TRASH_RETENTION_DAYS * 86_400_000).toISOString(),
  })
  saveMockTrash(trash)
}

export async function mockGetTrash(): Promise<TrashResponse> {
  await delay(120)
  return { notes: loadMockTrash(), retention_days: MOCK_TRASH_RETENTION_DAYS }
}

/** 恢复软删笔记：从回收站移回时间流（保持原 created_at 排序位置），返回实际恢复条数 */
export async function mockRestoreNotes(ids: string[]): Promise<number> {
  await delay(120)
  const want = new Set(ids)
  const trash = loadMockTrash()
  const hit = trash.filter((n) => want.has(n.id))
  if (hit.length === 0) return 0
  const notes = loadMockNotes().filter((n) => !want.has(n.id))
  for (const t of hit) {
    const { deleted_at: _d, purge_at: _p, ...note } = t
    notes.push(note)
  }
  saveMockNotes(notes)
  saveMockTrash(trash.filter((n) => !want.has(n.id)))
  return hit.length
}

export async function mockPurgeNotes(ids: string[]): Promise<number> {
  await delay(120)
  const want = new Set(ids)
  const trash = loadMockTrash()
  const kept = trash.filter((n) => !want.has(n.id))
  saveMockTrash(kept)
  return trash.length - kept.length
}

export async function mockEmptyTrash(): Promise<number> {
  await delay(120)
  const n = loadMockTrash().length
  saveMockTrash([])
  return n
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

/** 演示问答的问句框架词：去掉后剩下的才是话题词（「我最近在想什么」→ 空 → 走「最近想法」意图） */
const ASK_FRAME_RE =
  /我|你|的|了|吗|呢|啊|是|在|有|过|把|被|和|与|或|关于|对于|最近|近期|之前|上次|那个|哪些|哪个|哪|什么|怎么|怎样|如何|为什么|多少|几|记|想|看法|想法|点子|要点|内容|东西|一下|一次|曾经|以前|现在|目前/g

function askTopicGrams(question: string): string[] {
  const stripped = question.toLowerCase().replace(ASK_FRAME_RE, " ")
  const grams = new Set<string>()
  for (const seg of stripped.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (/^[\p{Script=Han}]+$/u.test(seg)) {
      if (seg.length === 1) grams.add(seg)
      for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2))
    } else if (seg.length >= 2) {
      grams.add(seg)
    }
  }
  return [...grams]
}

function askExcerpt(n: Note): string {
  if (n.is_sensitive) return "（敏感卡片，原文只在你点开时显示）"
  const head = n.url_title ?? (n.title && n.title !== n.content ? n.title : null)
  const main = n.url_title ? (n.url_summary ?? "") : n.content
  const text = (head ? `${head}${main ? `：${main}` : ""}` : main).replace(/\s+/g, " ")
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export async function mockAsk(question: string): Promise<AskResponse> {
  await delay(700)
  const notes = loadMockNotes()
  const grams = askTopicGrams(question)
  const scored = notes
    .map((n) => {
      const text = `${n.title ?? ""} ${n.content} ${n.url_title ?? ""} ${n.tags.join(" ")}`.toLowerCase()
      const score = grams.reduce((s, g) => s + (text.includes(g) ? 1 : 0), 0)
      return { n, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n.created_at.localeCompare(a.n.created_at))
    .slice(0, 3)
  let hits = scored.map((x) => x.n)
  let lead: string
  if (hits.length > 0) {
    lead = `根据你的笔记，与「${question}」最相关的有 ${hits.length} 条：`
  } else if (grams.length === 0 || /最近|近期|想什么|在想/.test(question)) {
    hits = notes
      .filter((n) => n.category === "idea")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 3)
    lead = hits.length > 0 ? `你最近记下的想法有 ${hits.length} 条：` : "你还没有记下想法类的碎念。"
  } else {
    lead = `没有在你的笔记里找到与「${question}」直接相关的内容。演示模式只做关键词匹配；连接真实后端后会用语义召回，并由 AI 结合笔记生成回答。`
  }
  const body = hits.map((n, i) => `${askExcerpt(n)} [${i + 1}]`).join("；")
  const answer = `（演示回答）${lead}${body}${hits.length > 0 ? "。连接真实后端后，这里会由 AI 结合检索结果生成完整回答。" : ""}`
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

/** 本地日历周（周一起）/ 月的起止，与 backend/src/reports.ts thisWeekRange / thisMonthRange 同口径 */
function thisPeriodRange(period: ReportPeriod, now = Date.now()): { start: string; end: string } {
  const today = localDateOf(now)
  if (period === "month") return { start: `${today.slice(0, 7)}-01`, end: today }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay()
  return { start: addDays(today, -((dow + 6) % 7)), end: today }
}

const seedReports: WeeklyReport[] = [
  {
    id: "r-1",
    user_id: "u-1",
    week_start: addDays(thisPeriodRange("week").start, -7),
    period: "week",
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

/** 演示模式手动生成的报告落本地；同一周期重复生成覆盖（与服务端 weekly_reports 唯一键同语义） */
function loadMockReports(): WeeklyReport[] {
  let stored: WeeklyReport[] = []
  try {
    const raw = localStorage.getItem(MOCK_REPORTS_KEY)
    if (raw) stored = JSON.parse(raw) as WeeklyReport[]
  } catch {
    stored = []
  }
  const key = (r: WeeklyReport) => `${r.period ?? "week"}:${r.week_start}`
  const taken = new Set(stored.map(key))
  return [...stored, ...seedReports.filter((r) => !taken.has(key(r)))].sort((a, b) =>
    a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0,
  )
}

function saveMockReports(reports: WeeklyReport[]) {
  localStorage.setItem(MOCK_REPORTS_KEY, JSON.stringify(reports))
}

export async function mockGetReports(): Promise<ReportsResponse> {
  await delay()
  return { reports: loadMockReports().map(({ content_md: _md, ...r }) => r) }
}

export async function mockGetReport(id: string): Promise<WeeklyReport> {
  await delay(120)
  const report = loadMockReports().find((r) => r.id === id)
  if (!report) throw new Error("report not found")
  return report
}

const REPORT_CATEGORY_LABEL: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
  expense: "支出",
  income: "收入",
  transfer: "资金往来",
}

function escapeMdText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "'")
}

function reportRowTitle(n: Note, max: number): string {
  const t = (n.title?.trim() || n.url_title?.trim() || n.content.trim().split(/\r?\n/)[0] || "").replace(/\s+/g, " ")
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 演示模式生成本周 / 本月报告：与 backend generatePeriodReport 的确定性部分（fallbackMarkdown + todoSection）
 * 同口径——按本地日期取期段内笔记、敏感笔记只计数不展示、期段无笔记返回 null 由页面给引导文案；
 * 本地没有模型，不做 AI 叙述。
 */
export async function mockGenerateReport(period: ReportPeriod = "week"): Promise<WeeklyReport | null> {
  await delay(600)
  const { start, end } = thisPeriodRange(period)
  const inRange = (iso: string) => {
    const d = localDateOf(Date.parse(iso))
    return d >= start && d <= end
  }
  const all = loadMockNotes()
  const notes = all
    .filter((n) => inRange(n.created_at))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
  if (notes.length === 0) return null

  const label = period === "month" ? "月报" : "周报"
  const unit = period === "month" ? "本月" : "本周"
  const byCat = new Map<string, Note[]>()
  for (const n of notes) {
    const k = n.category ?? "idea"
    if (!byCat.has(k)) byCat.set(k, [])
    byCat.get(k)!.push(n)
  }
  const sensitive = notes.filter((n) => n.is_sensitive === 1).length
  let md = `# 碎念${label}（${start} ~ ${end}）\n\n${unit}共记录 ${notes.length} 条${sensitive > 0 ? `（含 ${sensitive} 条敏感记录，仅计数不展示内容）` : ""}。\n`
  for (const [cat, rows] of byCat) {
    md += `\n## ${REPORT_CATEGORY_LABEL[cat] ?? cat}（${rows.length}）\n`
    const hidden = rows.filter((n) => n.is_sensitive === 1).length
    for (const n of rows.filter((n) => n.is_sensitive !== 1)) md += `- ${escapeMdText(reportRowTitle(n, 60))}\n`
    if (hidden > 0) md += `- （另有 ${hidden} 条敏感记录，内容不展示）\n`
  }
  const todos = notes.filter((n) => n.category === "todo")
  const doneInPeriod = all.filter(
    (n) => n.category === "todo" && n.todo_done === 1 && n.is_sensitive !== 1 && inRange(n.done_at ?? n.updated_at),
  )
  md += `\n## 待办盘点\n${unit}新增待办 ${todos.length} 条，共完成 ${doneInPeriod.length} 条。\n`
  if (doneInPeriod.length > 0) {
    md += `\n已完成：\n`
    for (const n of doneInPeriod.slice(0, 10)) md += `- [x] ${escapeMdText(reportRowTitle(n, 40))}\n`
  }
  const open = todos.filter((n) => n.todo_done !== 1 && n.is_sensitive !== 1)
  if (open.length > 0) {
    md += `\n未完成：\n`
    for (const n of open.slice(0, 10)) md += `- [ ] ${escapeMdText(reportRowTitle(n, 40))}\n`
  }
  md += `\n> 演示模式：本报告由本地统计拼接，未经 AI 叙述；登录真实账号后的报告会由模型讲述「这段时间你在想什么」。\n`

  const report: WeeklyReport = {
    id: `r-${period}-${start}`,
    user_id: "u-1",
    week_start: start,
    period,
    content_md: md,
    created_at: new Date().toISOString(),
  }
  const rest = loadMockReports().filter((r) => !((r.period ?? "week") === period && r.week_start === start) && !seedReports.includes(r))
  saveMockReports([report, ...rest])
  return report
}

/** 浏览器本地时区的 "YYYY-MM-DD"（与真实 API 按 tz_offset 分桶同口径） */
function localDateOf(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function addDays(iso: string, delta: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10)
}

/** 与 backend/src/stats.ts computeStreaks 同算法：今天没记但昨天有记，连续仍算存活 */
function computeStreaks(days: Iterable<string>, today: string): { current: number; longest: number } {
  const set = new Set(days)
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const d of [...set].sort()) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1
    if (run > longest) longest = run
    prev = d
  }
  let anchor: string | null = set.has(today) ? today : set.has(addDays(today, -1)) ? addDays(today, -1) : null
  let current = 0
  while (anchor && set.has(anchor)) {
    current++
    anchor = addDays(anchor, -1)
  }
  return { current, longest }
}

export async function mockGetStats(
  days = 365,
  scope?: { tag?: string; scopeDays?: number },
): Promise<StatsResponse> {
  await delay(120)
  const today = localDateOf(Date.now())
  const since = addDays(today, -(days - 1))
  const scopeSince = scope?.scopeDays ? addDays(today, -(scope.scopeDays - 1)) : null
  const notes = loadMockNotes().filter((n) => {
    if (n.tags.includes("示例")) return false
    if (scopeSince && localDateOf(Date.parse(n.created_at)) < scopeSince) return false
    if (scope?.tag && (n.is_sensitive === 1 || !n.tags.includes(scope.tag))) return false
    return true
  })
  const dailyMap = new Map<string, number>()
  const allDays = new Set<string>()
  const catMap = new Map<string, number>()
  const srcMap = new Map<string, number>()
  const tagMap = new Map<string, number>()
  for (const n of notes) {
    const d = localDateOf(Date.parse(n.created_at))
    allDays.add(d)
    if (d >= since && d <= today) dailyMap.set(d, (dailyMap.get(d) ?? 0) + 1)
    catMap.set(n.category ?? "pending", (catMap.get(n.category ?? "pending") ?? 0) + 1)
    srcMap.set(n.source, (srcMap.get(n.source) ?? 0) + 1)
    if (n.is_sensitive !== 1) for (const t of n.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1)
  }
  const byCount = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const threadIds = new Set(notes.map((n) => n.thread_id).filter((t): t is string => !!t))
  return {
    total_notes: notes.length,
    thread_count: seedThreads.filter((t) => threadIds.has(t.id)).length,
    active_days: allDays.size,
    daily: [...dailyMap.entries()].sort().map(([date, count]) => ({ date, count })),
    streak: computeStreaks(allDays, today),
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
