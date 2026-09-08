import { SAFETY_PROMISE, SAFETY_PROMISE_LEAD } from "@/lib/utils"

/**
 * 注册页 / 设置页共用的安全承诺渲染：首句（R334 审查人措辞）的「已标注」「未标注 / 已取消标注」加粗，
 * 其余沿用 SAFETY_PROMISE 纯文本。文本合并后与 `SAFETY_PROMISE_LEAD + SAFETY_PROMISE` 完全一致。
 */
export function SafetyPromise() {
  return (
    <>
      <strong>{SAFETY_PROMISE_LEAD.marked}</strong>
      {SAFETY_PROMISE_LEAD.mid}
      <strong>{SAFETY_PROMISE_LEAD.unmarked}</strong>
      {SAFETY_PROMISE_LEAD.tail}
      {SAFETY_PROMISE}
    </>
  )
}
