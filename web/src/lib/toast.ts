import type { ExternalToast } from "sonner"

// sonner 不进首屏：按需加载；Toaster 挂载时会回放已创建但尚未展示的 toast
const load = () => import("sonner")

export function toast(message: string, opts?: ExternalToast) {
  void load().then((s) => s.toast(message, opts))
}

toast.success = (message: string, opts?: ExternalToast) => {
  void load().then((s) => s.toast.success(message, opts))
}

toast.error = (message: string, opts?: ExternalToast) => {
  void load().then((s) => s.toast.error(message, opts))
}

toast.dismiss = () => {
  void load().then((s) => s.toast.dismiss())
}
