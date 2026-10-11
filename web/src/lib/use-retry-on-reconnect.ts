import { useEffect, useRef } from "react"

/** 在线但连不上服务端时的自动重拉间隔：短起步、封顶 5 分钟 */
const BACKOFF_MS = [20_000, 40_000, 80_000, 160_000, 300_000]
/** 错误态消失并保持这么久，视为已恢复，退避计数归零 */
const RECOVERED_AFTER_MS = 90_000

/**
 * 页面处于「连不上服务端」错误态时自动重拉：浏览器联网、回到前台立即重拉；
 * 在线则按退避定时重拉。离开错误态即停止，不打扰正常页面。
 */
export function useRetryOnReconnect(active: boolean, retry: () => void): void {
  const retryRef = useRef(retry)
  const attemptRef = useRef(0)

  useEffect(() => {
    retryRef.current = retry
  }, [retry])

  useEffect(() => {
    if (!active) {
      const t = window.setTimeout(() => {
        attemptRef.current = 0
      }, RECOVERED_AFTER_MS)
      return () => window.clearTimeout(t)
    }

    let timer: number | null = null
    const fire = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      retryRef.current()
    }
    const onOnline = () => {
      attemptRef.current = 0
      fire()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") fire()
    }
    window.addEventListener("online", onOnline)
    document.addEventListener("visibilitychange", onVisible)
    if (typeof navigator === "undefined" || navigator.onLine !== false) {
      const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)]
      attemptRef.current += 1
      timer = window.setTimeout(fire, delay)
    }
    return () => {
      window.removeEventListener("online", onOnline)
      document.removeEventListener("visibilitychange", onVisible)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active])
}
