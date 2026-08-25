import { useRef, useState } from "react"
import { CloudOff, RefreshCw, X } from "lucide-react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"
import { defaultApiBase } from "@/lib/settings"

// 长驻 PWA 里 SW 只在页面加载时检查一次更新，常开着不关的用户可能几天
// 都见不到更新提示：定期 + 回到前台时主动 update()，让 needRefresh 能
// 在长会话里触发。仍保留手动"刷新"确认，避免自动 reload 丢用户未保存输入。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const INSTALL_RETRY_DELAY_MS = 45 * 1000
// 注册失败绝大多数是浏览器侧间歇性网络失败：静默指数退避重试，成功即撤
// 横幅；重试次数有限，避免对持续性故障无限打点
const REGISTER_RETRY_DELAYS_MS = [30_000, 60_000, 120_000]

/** 注册失败原因轻量上报：只带错误名称/消息与重试序号（不含任何用户内容
 * 或凭据），供运维统计真实用户侧的失败原因分布；上报失败静默。 */
function reportSwError(err: unknown, retry: number) {
  try {
    const base = defaultApiBase()
    if (!base) return
    const e = err instanceof Error ? err : new Error(String(err))
    void fetch(`${base.replace(/\/$/, "")}/api/metrics/sw-error`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: e.name.slice(0, 80), message: e.message.slice(0, 300), retry }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // 上报绝不能影响页面
  }
}

export function ReloadPrompt() {
  const [registerError, setRegisterError] = useState(false)
  const retryAttempt = useRef(0)

  const scheduleRegisterRetry = () => {
    const attempt = retryAttempt.current
    if (attempt >= REGISTER_RETRY_DELAYS_MS.length || !("serviceWorker" in navigator)) return
    retryAttempt.current = attempt + 1
    setTimeout(() => {
      if (!navigator.onLine) {
        // 离线时本次不计数，等下一档延时再试
        retryAttempt.current = attempt
        scheduleRegisterRetry()
        return
      }
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setRegisterError(false))
        .catch((err) => {
          reportSwError(err, retryAttempt.current)
          scheduleRegisterRetry()
        })
    }, REGISTER_RETRY_DELAYS_MS[attempt])
  }

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
      // 安装失败自愈（R178 P1-1）：install 阶段预缓存拉取失败会让新 SW 变
      // redundant，注册长期停在无 active 状态、离线彻底不可用。注册后延时
      // 复查一次：既无 active 也无 installing 即视为安装失败，update() 重试
      setTimeout(() => {
        if (navigator.onLine && !r.active && !r.installing) void r.update().catch(() => {})
      }, INSTALL_RETRY_DELAY_MS)
      // 假健康自愈（audit-r271 P1-8）：SW 已 active 但 Workbox precache 缺失/
      // 为空——离线刷新必然 ERR_FAILED 且 update() 不会重装（脚本未变）。
      // 检测到即做一次完整修复：注销全部 registration → 清空 caches →
      // cache-busting 重新注册（不强刷页面，下次加载即恢复）
      setTimeout(() => {
        void (async () => {
          try {
            if (!navigator.onLine || !r.active || r.installing || r.waiting || !("caches" in window)) return
            const keys = await caches.keys()
            const precacheKey = keys.find((k) => k.includes("precache"))
            const entries = precacheKey ? await (await caches.open(precacheKey)).keys() : []
            if (entries.length > 0) return
            const regs = await navigator.serviceWorker.getRegistrations()
            await Promise.all(regs.map((reg) => reg.unregister().catch(() => false)))
            await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
            await navigator.serviceWorker.register(`/sw.js?reinstall=${Date.now()}`, { scope: "/" })
          } catch {
            // 自愈失败不打扰用户；设置页仍有可见的手动修复出路
          }
        })()
      }, INSTALL_RETRY_DELAY_MS)
    },
    // SW 注册失败意味着离线缓存/推送不可用：可见化降级提示而非静默失效
    // （R194 P2-3），同时上报失败原因并退避自动重试，成功即撤横幅
    onRegisterError(err) {
      setRegisterError(true)
      reportSwError(err, 0)
      scheduleRegisterRetry()
    },
  })

  if (registerError && !needRefresh) {
    return (
      <div className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-center gap-3 rounded-xl border bg-popover p-3 shadow-lg md:bottom-6">
        <CloudOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-sm">离线缓存不可用（Service Worker 注册失败），在线功能不受影响；会自动重试，也可刷新重试</p>
        <button
          onClick={() => setRegisterError(false)}
          aria-label="关闭"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

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
