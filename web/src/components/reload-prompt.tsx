import { RefreshCw, X } from "lucide-react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"

// 长驻 PWA 里 SW 只在页面加载时检查一次更新，常开着不关的用户可能几天
// 都见不到更新提示：定期 + 回到前台时主动 update()，让 needRefresh 能
// 在长会话里触发。仍保留手动"刷新"确认，避免自动 reload 丢用户未保存输入。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, r) {
      if (!r) return
      const check = () => {
        if (navigator.onLine) void r.update().catch(() => {})
      }
      setInterval(check, UPDATE_CHECK_INTERVAL_MS)
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check()
      })
    },
  })

  if (!needRefresh) return null

  return (
    <div className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-center gap-3 rounded-xl border bg-popover p-3 shadow-lg md:bottom-6">
      <p className="min-w-0 flex-1 text-sm">有新版本，点击刷新</p>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>
        <RefreshCw className="size-3.5" />
        刷新
      </Button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="关闭"
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
