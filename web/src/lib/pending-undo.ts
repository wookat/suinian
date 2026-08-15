// 时间流批量撤销条的 localStorage 持久化键：timeline 写入/恢复；回收站在
// 恢复或彻底删除笔记后剔除对应 id，避免返回时间流时残留过期的撤销条。
export const PENDING_UNDO_KEY = "suinian:pending-undo"

/** 从待撤销的「恢复」条目中剔除给定笔记 id（已在回收站处理过的笔记不再可撤销）。 */
export function prunePendingUndoIds(ids: string[]): void {
  try {
    const raw = localStorage.getItem(PENDING_UNDO_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { kind?: unknown; ids?: unknown }
    const kind = saved.kind ?? "restore"
    if (kind !== "restore") return
    const kept = Array.isArray(saved.ids)
      ? saved.ids.filter((v): v is string => typeof v === "string" && !ids.includes(v))
      : []
    if (kept.length === 0) localStorage.removeItem(PENDING_UNDO_KEY)
    else localStorage.setItem(PENDING_UNDO_KEY, JSON.stringify({ ...saved, ids: kept }))
  } catch {
    // ignore
  }
}

/** 清空待撤销条目（清空回收站后任何「恢复」撤销都不再可能成功）。 */
export function clearStoredPendingUndo(): void {
  try {
    localStorage.removeItem(PENDING_UNDO_KEY)
  } catch {
    // ignore
  }
}
