/**
 * 今日回顾与笔记删除之间的轻量事件桥：删除笔记（含一键清除示例）时立即
 * 让回顾卡剔除引用了这些笔记的条目；撤销删除时让回顾卡重新拉取。
 */

type Listener = (deletedNoteIds: string[] | null) => void

const listeners = new Set<Listener>()

/** 订阅回顾相关的笔记变更；返回取消订阅函数。ids=null 表示需要整体重取。 */
export function onReviewNotesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 笔记（乐观）删除后调用：回顾卡立即剔除引用这些笔记的条目 */
export function notifyNotesDeleted(ids: string[]): void {
  if (ids.length === 0) return
  for (const l of listeners) l(ids)
}

/** 删除被撤销或按筛选批量删除（无法拿到 id 列表）后调用：回顾卡整体重取 */
export function notifyReviewRefresh(): void {
  for (const l of listeners) l(null)
}
