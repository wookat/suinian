// 问答隔离标记的展示层纯函数（无 React/DOM 依赖，后端 vitest 直接引入做单测）。

// 隔离标记短句化（R294 P2-3，audit-r293 §9.3）：服务端标记为防仿冒是较长的
// 固定文案，渲染层换成短句，「查看原文」由横幅按钮承担。只改展示，存为笔记
// 仍用原文。
const GUARD_MARK_SHORTS: [string, string][] = [
  ["〔已隔离笔记内指令，未采纳；原文可在引用的笔记卡片中查看〕", "〔已隔离笔记内指令〕"],
  ["〔已隔离危险命令（会下载执行远程代码或建立外连），未展示；原文可在引用的笔记卡片中查看〕", "〔已隔离危险命令〕"],
  ["〔代码安全判别暂不可用，已对疑似可执行代码保守隔离（未展示）；原文可在引用的笔记卡片中查看〕", "〔判别暂不可用，已保守隔离〕"],
  ["相关笔记内容命中安全隔离规则，已隔离未采纳；原文可在引用的笔记卡片中查看。", "相关内容命中安全隔离规则，已隔离未采纳。"],
]
// 降级窗口的答尾长提示整句折进横幅（横幅已说明降级+可重试），正文不重复。
const DEGRADED_NOTICE_RE =
  /\n*（本次回答处于代码安全判别降级窗口：判别服务超时\/不可用，系统已对代码区域保守隔离，稍后重试可获得完整判定。）\n*/g

export function shortenGuardMarks(content: string): string {
  let out = content.replace(DEGRADED_NOTICE_RE, "\n")
  for (const [long, short] of GUARD_MARK_SHORTS) out = out.split(long).join(short)
  return out.trim()
}

// 隔离位置定位（R296 P2-1，audit-r295：提示从「吓人」矫枉到「看不懂」）：
// 找到含隔离标记的那一段（非空行序号）与同段的 [n] 引用，横幅里告诉用户
// 被隔离的是哪一条，「查看原文」直接滚到对应笔记卡片。
const ISOLATION_MARK_RE = /〔已隔离|命中安全隔离规则|〔代码安全判别暂不可用/
const CITATION_RE = /[[［](\d{1,2})[\]］]/

export function isolatedMarkLocation(content: string): { para: number; refIndex: number | null } | null {
  const lines = shortenGuardMarks(content)
    .split("\n")
    .filter((l) => l.trim().length > 0)
  for (let i = 0; i < lines.length; i++) {
    if (!ISOLATION_MARK_RE.test(lines[i])) continue
    const own = lines[i].match(CITATION_RE)
    if (own) return { para: i + 1, refIndex: parseInt(own[1], 10) }
    // 标记独占一行：被隔离段的引用落在紧邻的行上——先向后、再向前找最近的 [n]
    for (let d = 1; d < lines.length; d++) {
      for (const j of [i + d, i - d]) {
        if (j < 0 || j >= lines.length || ISOLATION_MARK_RE.test(lines[j])) continue
        const m = lines[j].match(CITATION_RE)
        if (m) return { para: i + 1, refIndex: parseInt(m[1], 10) }
      }
    }
    return { para: i + 1, refIndex: null }
  }
  return null
}

export interface IsolationAttributionInput {
  content: string
  refs?: { index: number; note: { contains_executable_command?: boolean; fold?: boolean } }[]
  isolatedRefs?: number[]
}

/**
 * 隔离横幅归因（R308 P1-1）：优先服务端按收口前后引用差集给出的 isolated_refs，
 * 其次答案文本里隔离标记邻近的 [n]，再次引用集合里数据面判危的笔记，最后是宽判据
 * 折叠（fold）的笔记；皆无则不归因（不回落 refs[0]——指错笔记比不指更糟）。
 */
export function isolatedRefTarget(m: IsolationAttributionInput): number | null {
  const refIndexes = new Set((m.refs ?? []).map((r) => r.index))
  const fromServer = (m.isolatedRefs ?? []).find((n) => refIndexes.has(n))
  if (fromServer !== undefined) return fromServer
  const flagged = (m.refs ?? []).find((r) => r.note.contains_executable_command)
  // 危险命令隔离标记：数据面判危的引用比标记邻近的 [n] 更可信（邻近角标可能
  // 只是同段落里幸存的善意引用）
  if (flagged && /〔已隔离危险命令|〔代码安全判别暂不可用/.test(m.content)) return flagged.index
  const loc = isolatedMarkLocation(m.content)
  if (loc?.refIndex != null && refIndexes.has(loc.refIndex)) return loc.refIndex
  if (flagged) return flagged.index
  const folded = (m.refs ?? []).filter((r) => r.note.fold)
  return folded.length === 1 ? folded[0].index : null
}
