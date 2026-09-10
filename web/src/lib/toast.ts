import type { ExternalToast, toast as SonnerToast } from "sonner"

/**
 * sonner 不进首屏：真正的 toast 实现由 Toaster 分包（components/ui/sonner）加载后注册进来，
 * 之前发出的 toast 先排队，Toaster 挂载时回放。
 * 这里不能自己 `import("sonner")`：离线时那一次失败会让浏览器把 sonner 分包 URL 记成「失败」，
 * 之后 Toaster 分包（静态依赖同一 URL）联网也装不上，整个会话再没有 toast 与命令面板。
 */
export const TOAST_WANTED_EVENT = "suinian:toast-wanted"

/** 排队超过这么久的提示已经过时（用户早已离开当时的操作），不再回放。 */
const PENDING_MAX_AGE_MS = 60_000
const PENDING_MAX = 20

type Impl = typeof SonnerToast
type Pending = { at: number; run: (impl: Impl) => void }

let impl: Impl | null = null
let pending: Pending[] = []

function enqueue(run: (impl: Impl) => void) {
  if (impl) {
    run(impl)
    return
  }
  pending.push({ at: Date.now(), run })
  if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX)
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TOAST_WANTED_EVENT))
}

/** Toaster 分包加载后调用：接管后续调用并回放未过期的排队提示。 */
export function registerToastImpl(next: Impl) {
  impl = next
  const now = Date.now()
  const queued = pending
  pending = []
  for (const p of queued) if (now - p.at <= PENDING_MAX_AGE_MS) p.run(next)
}

export function toast(message: string, opts?: ExternalToast) {
  enqueue((t) => void t(message, opts))
}

toast.success = (message: string, opts?: ExternalToast) => {
  enqueue((t) => void t.success(message, opts))
}

toast.error = (message: string, opts?: ExternalToast) => {
  enqueue((t) => void t.error(message, opts))
}

toast.dismiss = () => {
  pending = []
  impl?.dismiss()
}
