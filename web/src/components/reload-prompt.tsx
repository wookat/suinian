import { useEffect, useRef } from "react"
import { RefreshCw, X } from "lucide-react"
import { useRegisterSW } from "virtual:pwa-register/react"
import { Button } from "@/components/ui/button"
import { defaultApiBase } from "@/lib/settings"
import { detachServiceWorker, giveUpOfflineCache, isOfflineCacheEnabled, withSwTimeout } from "@/lib/sw-control"
import { isPushWanted, reconcilePushSubscription, registrationHasPush } from "@/lib/push"

// 长驻 PWA 里 SW 只在页面加载时检查一次更新，常开着不关的用户可能几天
// 都见不到更新提示：定期 + 回到前台时主动 update()，让 needRefresh 能
// 在长会话里触发。仍保留手动"刷新"确认，避免自动 reload 丢用户未保存输入。
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
const INSTALL_RETRY_DELAY_MS = 45 * 1000
// 注册失败绝大多数是浏览器侧间歇性网络失败：静默指数退避重试，成功即撤
// 横幅；重试次数有限，避免对持续性故障无限打点
const REGISTER_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000]
// 「Timed out while trying to start the Service Worker」是浏览器 SW 组件
// 启动超时：同一个 wedge 的 SW 实例上原样 register() 只会原样超时（生产
// sw_error_reports 实测 retry 0→3 全部失败）。从第 2 次重试起先做完整
// 重置（注销全部 registration + 清空 CacheStorage）再带 cache-busting
// 查询串注册，让浏览器起一个全新的 SW 实例而不是复用卡死的那个。
const HARD_RESET_FROM_ATTEMPT = 2
const SW_START_TIMEOUT_RE = /timed out while trying to start the service worker/i
// registration 存在但 active/installing/waiting 全空且无 controller：安装
// 失败后 worker 变 redundant 被回收的卡死终态，不自查会永远停在这里
const NO_WORKER_CHECK_DELAY_MS = 20_000
const NO_WORKER_CHECK_INTERVAL_MS = 60_000
// R288 P1-2：SW 组件级悬挂时 unregister()/register() 既不 resolve 也不 reject
// （R287 实测 120s 无结算），此前的自愈 await 会永远挂着、SwNoWorkerHealed
// 永不产生。所有自愈动作一律加超时；超时即判定 wedge，转成用户可操作的出路。
const HEAL_TIMEOUT_MS = 20_000
// R314 P2（audit-r313 §8.1）：Web Push 订阅挂在 registration 上，下面每一条自愈路径的
// unregister() 都会连带把订阅丢掉（浏览器侧 getSubscription()→null，服务端下次推送
// 收到 410 删行）。自愈后等新 SW active 再对账重订阅；对账本身也周期性做一次。
const PUSH_RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000
const PUSH_RESTORE_WAIT_MS = 30_000

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

/** 自愈/卡死态观测事件：借用 sw-error 上报通道（只有 name/message/retry），
 * 让生产侧能一手核对自愈是否真的发生、卡死态出现频率。 */
class SwHealEvent extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** 完整重置后重注册：注销全部 registration → 清空全部 CacheStorage →
 * 带 cache-busting 查询串重新注册。用于 SW 启动超时与「registration 存在
 * 但无任何 worker」两类靠原样 register() 无法走出的卡死态。 */
async function hardResetAndRegister(): Promise<ServiceWorkerRegistration> {
  const regs = await navigator.serviceWorker.getRegistrations()
  const hadPush = (await Promise.all(regs.map(registrationHasPush))).some(Boolean)
  await Promise.all(regs.map((reg) => reg.unregister().catch(() => false)))
  if ("caches" in window) {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
  }
  const reg = await navigator.serviceWorker.register(`/sw.js?reinstall=${Date.now()}`, { scope: "/" })
  if (hadPush || isPushWanted()) void restorePushWhenActive(reg)
  return reg
}

let lastPushReconcileAt = 0

/** 节流版对账：同一页面 10 分钟内只做一次（visibilitychange 会频繁触发）。 */
function reconcilePushThrottled(reg?: ServiceWorkerRegistration, force = false) {
  if (!isPushWanted()) return
  const now = Date.now()
  if (!force && now - lastPushReconcileAt < PUSH_RECONCILE_MIN_INTERVAL_MS) return
  lastPushReconcileAt = now
  void reconcilePushSubscription(reg).then((outcome) => {
    if (outcome === "resubscribed" || outcome === "synced")
      reportSwError(new SwHealEvent("SwPushReconciled", outcome), 0)
  })
}

/** 自愈重注册后新 SW 还在 installing：等它 active（最多 30s）再重订阅。 */
async function restorePushWhenActive(reg: ServiceWorkerRegistration) {
  const deadline = Date.now() + PUSH_RESTORE_WAIT_MS
  while (!reg.active && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!reg.active) return
  reconcilePushThrottled(reg, true)
}

/** 带超时的完整重置：返回 null 表示浏览器 SW 组件没有结算（wedge 确诊）。 */
function hardResetWithTimeout(): Promise<ServiceWorkerRegistration | null> {
  return withSwTimeout(() => hardResetAndRegister(), HEAL_TIMEOUT_MS)
}

/**
 * 离线缓存未开启（R294 P1-3 的默认态）：不注册、不弹窗。只做一件事——把历史
 * 遗留的 registration 静默清掉，否则旧用户的页面仍被卡死的 SW 接管。
 */
function SwCleanup() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        if (regs.length === 0 && !navigator.serviceWorker.controller) return
        // 遗留 registration 上还挂着推送订阅：清掉它等于静默关掉用户的提醒渠道，
        // 保留（在线功能不受影响；用户在设置里关推送或关离线缓存时才真正注销）
        if ((await Promise.all(regs.map(registrationHasPush))).some(Boolean)) return
        await detachServiceWorker(8_000)
      } catch {
        // 清理失败不影响在线功能，不打扰用户
      }
    })()
  }, [])
  return null
}

export function ReloadPrompt() {
  if (!isOfflineCacheEnabled()) return <SwCleanup />
  return <ReloadPromptInner />
}

function ReloadPromptInner() {
  const retryAttempt = useRef(0)
  const startTimeout = useRef(false)
  const noWorkerStreak = useRef(0)
  const noWorkerHealed = useRef(false)

  // 无 worker 卡死态自愈（audit-r285 P2-3）：registration 存在但 active/
  // installing/waiting 全空且无 controller —— 安装失败后 worker 变 redundant
  // 被回收的终态，update()/原样 register() 都不会重装（脚本未变）。连续两次
  // 检查（隔 60s）仍处此态才动手，避免把安装间隙的瞬态误判成卡死；自愈用
  // 完整重置 + cache-busting 重注册，只做一次，失败则交给设置页的手动修复。
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    let cancelled = false
    const check = async () => {
      try {
        if (cancelled || !navigator.onLine || noWorkerHealed.current) return
        const reg = await navigator.serviceWorker.getRegistration()
        const stuck = !!reg && !reg.active && !reg.installing && !reg.waiting && !navigator.serviceWorker.controller
        if (!stuck) {
          noWorkerStreak.current = 0
          return
        }
        noWorkerStreak.current += 1
        if (noWorkerStreak.current < 2) return
        noWorkerHealed.current = true
        reportSwError(new SwHealEvent("SwNoWorkerStuck", "registration without any worker; hard reset"), 0)
        const healed = await hardResetWithTimeout()
        if (healed === null) {
          // R294 P1-3：自愈不结算 = 浏览器 SW 组件卡死（生产遥测里的终态）。
          // 不再弹窗骚扰：彻底注销 + 回到离线缓存关闭态，在线功能立刻恢复。
          reportSwError(new SwHealEvent("SwNoWorkerHealTimeout", `hard reset unsettled in ${HEAL_TIMEOUT_MS}ms`), 0)
          await giveUpOfflineCache("no-worker heal unsettled")
          return
        }
        reportSwError(new SwHealEvent("SwNoWorkerHealed", "hard reset register ok"), 0)
      } catch {
        // 自愈失败保持横幅/设置页出路，不打扰用户
      }
    }
    const first = setTimeout(() => void check(), NO_WORKER_CHECK_DELAY_MS)
    const timer = setInterval(() => void check(), NO_WORKER_CHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [])

  const scheduleRegisterRetry = () => {
    const attempt = retryAttempt.current
    if (!("serviceWorker" in navigator)) return
    // R294 P1-3：重试额度耗尽 = 终态失败，彻底 unregister 并停止再注册。
    if (attempt >= REGISTER_RETRY_DELAYS_MS.length) {
      void giveUpOfflineCache(`register failed ${attempt} times`)
      return
    }
    retryAttempt.current = attempt + 1
    setTimeout(() => {
      if (!navigator.onLine) {
        // 离线时本次不计数，等下一档延时再试
        retryAttempt.current = attempt
        scheduleRegisterRetry()
        return
      }
      const hard = startTimeout.current && attempt + 1 >= HARD_RESET_FROM_ATTEMPT
      const register: Promise<ServiceWorkerRegistration | null> = hard
        ? hardResetWithTimeout()
        : withSwTimeout(() => navigator.serviceWorker.register("/sw.js"), HEAL_TIMEOUT_MS)
      register
        .then((reg) => {
          if (reg === null) {
            // 注册调用本身没有结算：SW 组件级悬挂，继续退避重试没有意义 ⇒ 终态放弃
            reportSwError(
              new SwHealEvent("SwRegisterUnsettled", `register unsettled in ${HEAL_TIMEOUT_MS}ms (hard=${hard})`),
              retryAttempt.current,
            )
            void giveUpOfflineCache("register unsettled")
            return
          }
          if (hard) reportSwError(new SwHealEvent("SwStartTimeoutHealed", "hard reset register ok"), retryAttempt.current)
        })
        .catch((err) => {
          if (err instanceof Error && SW_START_TIMEOUT_RE.test(err.message)) startTimeout.current = true
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
        if (document.visibilityState === "visible") {
          check()
          reconcilePushThrottled(r)
        }
      })
      if (r.active) reconcilePushThrottled(r, true)
      else void restorePushWhenActive(r)
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
            reportSwError(new SwHealEvent("SwEmptyPrecacheHeal", "active SW with empty precache; hard reset"), 0)
            await hardResetAndRegister()
          } catch {
            // 自愈失败不打扰用户；设置页仍有可见的手动修复出路
          }
        })()
      }, INSTALL_RETRY_DELAY_MS)
    },
    // SW 注册失败意味着离线缓存/推送不可用：可见化降级提示而非静默失效
    // （R194 P2-3），同时上报失败原因并退避自动重试，成功即撤横幅
    // R294 P1-3：注册失败不再弹降级横幅（离线缓存是用户主动开的可选项，
    // 失败不影响在线功能）；只退避重试 + 遥测，额度耗尽即终态注销。状态与手动
    // 修复入口在「设置 → 离线与更新」里。
    onRegisterError(err) {
      if (err instanceof Error && SW_START_TIMEOUT_RE.test(err.message)) startTimeout.current = true
      reportSwError(err, 0)
      scheduleRegisterRetry()
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
