import { RefreshCw, X } from "lucide-react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"

export function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

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
