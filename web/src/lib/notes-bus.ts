/** 笔记集合变更事件：新建 / 修改 / 删除 / 恢复 / 彻底删除 / 批量 / 标签维护成功后由 api 层广播，
 *  供右栏统计、标签云等非页面归属的派生视图重新拉取；不携带数据、不区分动作。 */
type Listener = () => void

const listeners = new Set<Listener>()

export function onNotesMutated(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyNotesMutated(): void {
  for (const l of listeners) l()
}

/** 包装一次成功的写操作：结果原样返回，随后广播变更 */
export async function mutated<T>(op: Promise<T>): Promise<T> {
  const r = await op
  notifyNotesMutated()
  return r
}
