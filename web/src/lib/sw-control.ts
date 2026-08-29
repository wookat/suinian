import { defaultApiBase } from "./settings"

/** 本浏览器禁用 Service Worker 的开关（R288 P1-2 出路）：SW 组件级悬挂时，
 * unregister()/register() 都可能既不 resolve 也不 reject，只能让页面此后
 * 不再注册 SW，把在线功能救回来（离线缓存/推送在此模式下不可用）。 */
const SW_DISABLED_KEY = "sn_sw_disabled"

export function isSwDisabled(): boolean {
  try {
    return localStorage.getItem(SW_DISABLED_KEY) === "1"
  } catch {
    return false
  }
}

export function setSwDisabled(disabled: boolean) {
  try {
    if (disabled) localStorage.setItem(SW_DISABLED_KEY, "1")
    else localStorage.removeItem(SW_DISABLED_KEY)
  } catch {
    // storage 不可用时至少本次会话仍能靠调用方的重载参数生效
  }
}

/** SW 事件轻量上报（复用 /api/metrics/sw-error 通道，只带 name/message/retry，
 * 不含任何用户内容或凭据）；上报失败静默。 */
export function reportSwEvent(name: string, message: string, retry = 0) {
  try {
    const base = defaultApiBase()
    if (!base) return
    void fetch(`${base.replace(/\/$/, "")}/api/metrics/sw-error`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.slice(0, 80), message: message.slice(0, 300), retry }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // 上报绝不能影响页面
  }
}

/** 悬挂保护：SW 组件卡死时 unregister()/register()/caches 操作可能永不结算
 * （R287 一手观测：120s 既不 resolve 也不 reject）。所有自愈动作必须经过它，
 * 否则「自愈代码存在」但永远不会有结果。超时按失败处理。 */
export async function withSwTimeout<T>(op: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: number | undefined
  try {
    return await Promise.race([
      op(),
      new Promise<null>((resolve) => {
        timer = window.setTimeout(() => resolve(null), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 尝试把当前页面从 SW 控制下脱开：注销全部 registration + 清 CacheStorage，
 * 全部带超时。返回是否确认脱开（controller 消失或注销成功）。 */
export async function detachServiceWorker(timeoutMs = 8_000): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return true
  const ok = await withSwTimeout(async () => {
    const regs = await navigator.serviceWorker.getRegistrations()
    const results = await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
    if ("caches" in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
    }
    return regs.length === 0 || results.some((r) => r === true)
  }, timeoutMs)
  return ok === true
}

/** 用户可操作的最终出路：禁用 SW → 尽力注销（带超时，卡死也不挡）→ 重载。
 * 重载后 ReloadPrompt 不再注册 SW，注册/注销等在线请求不再经过悬挂的 SW。 */
export async function disableSwAndReload() {
  setSwDisabled(true)
  reportSwEvent("SwDisabledByUser", "user disabled service worker after wedge")
  await detachServiceWorker(5_000)
  location.reload()
}

/** 认证类请求悬挂时的一次性脱困尝试（R288 P1-3）：R287 定论为浏览器 SW
 * 组件级悬挂，被 SW 控制的页面里所有 fetch 都要等 SW 启动。这里在超时后
 * 尝试脱开 SW 控制再重试；成功与否都上报，便于生产侧一手核对。 */
let authEscapeTried = false

export async function escapeSwWedgeForAuth(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false
  if (authEscapeTried) return false
  authEscapeTried = true
  if (!navigator.serviceWorker.controller) return false
  reportSwEvent("SwAuthWedgeDetach", "auth request timed out under SW control; detaching")
  const ok = await detachServiceWorker(6_000)
  reportSwEvent(ok ? "SwAuthWedgeDetached" : "SwAuthWedgeDetachTimeout", `detach ok=${ok}`)
  return ok
}

/** 仅测试用：重置一次性状态 */
export function resetAuthEscapeStateForTest() {
  authEscapeTried = false
}
