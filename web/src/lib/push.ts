// Browser-side Web Push helpers: permission, subscribe/unsubscribe against the
// registered PWA service worker, syncing the subscription to the backend.
import { getPushConfig, subscribePush, unsubscribePush } from "./api"
import { isOfflineCacheEnabled } from "./sw-control"

export type PushSupport = "ok" | "unsupported" | "ios-needs-install"

/**
 * 本浏览器「用户开过推送」的意图标记（R314 P2，audit-r313 §8.1）。Web Push 订阅挂在 SW
 * registration 上：任何 unregister（SW 自愈重置、清理遗留 registration、浏览器回收）都会连带丢掉
 * 订阅，服务端随后收到 404/410 删行——渠道就这样静默失效。意图与订阅分开记：订阅丢了但意图在，
 * 页面下次就绪时静默重订阅并同步服务端。
 */
const PUSH_WANTED_KEY = "sn_push_wanted"

export function isPushWanted(): boolean {
  try {
    return localStorage.getItem(PUSH_WANTED_KEY) === "1"
  } catch {
    return false
  }
}

function setPushWanted(on: boolean) {
  try {
    if (on) localStorage.setItem(PUSH_WANTED_KEY, "1")
    else localStorage.removeItem(PUSH_WANTED_KEY)
  } catch {
    // storage 不可用：本次会话仍能订阅，只是失去自动恢复
  }
}

/** Whether this browser can subscribe right now (iOS Safari needs the PWA installed first). */
export function detectPushSupport(): PushSupport {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIos && !standalone ? "ios-needs-install" : "unsupported"
  }
  return "ok"
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器"
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : ""
  return [browser, os].filter(Boolean).join(" · ")
}

/** The current browser's push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

/** 把（已存在或刚建立的）订阅同步到服务端。 */
export async function syncSubscription(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("订阅数据不完整")
  await subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    ua: deviceLabel(),
  })
}

async function subscribeOn(reg: ServiceWorkerRegistration, vapidPublicKey: string): Promise<PushSubscription> {
  return (
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(vapidPublicKey) as BufferSource,
    }))
  )
}

/** Request permission, subscribe with the server's VAPID key, and sync to the backend. */
export async function enablePush(): Promise<void> {
  // 推送订阅挂在 PWA Service Worker 上；离线缓存（SW）默认关闭时无 registration 可用
  if (!isOfflineCacheEnabled()) throw new Error("推送依赖离线缓存（Service Worker），请先在设置→离线与更新里开启离线缓存后重试")
  const config = await getPushConfig()
  if (!config.enabled || !config.vapid_public_key) throw new Error("服务端未配置推送（VAPID）")
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("通知权限被拒绝，请在浏览器设置中允许本站通知后重试")
  // serviceWorker.ready 是一个永不 reject 的 promise：SW 注册失败/被禁用时会
  // 永远 pending，把首跑引导卡的按钮卡成无限转圈（R121 P2）。加超时兜底。
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("页面离线组件未就绪，请刷新页面后重试")), 10_000),
    ),
  ])
  const sub = await subscribeOn(reg, config.vapid_public_key)
  await syncSubscription(sub)
  setPushWanted(true)
}

/** Unsubscribe this browser and remove it from the backend. */
export async function disablePush(): Promise<void> {
  setPushWanted(false)
  const sub = await currentSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  await unsubscribePush(endpoint)
}

/** 本机退出登录 / 注销时清掉意图：换账号后不会把这台浏览器的订阅静默挂到新账号上。 */
export function forgetPushIntent() {
  setPushWanted(false)
}

/** 设置页确认「浏览器与服务端两侧都有本机订阅」时补记意图（R314 之前开的推送没有标记）。 */
export function rememberPushIntent() {
  setPushWanted(true)
}

/**
 * 订阅对账（R314 P2）：用户开过推送、通知权限仍在、SW 就绪，但 registration 上没有订阅
 * （SW 被重置/清理/回收过）⇒ 静默重订阅并同步服务端；已有订阅但服务端不认识这个 endpoint
 * （服务端因 404/410 删过行）⇒ 只补一次同步。任何失败静默，不打扰用户。
 * 返回值："resubscribed" 重建了订阅；"synced" 补了服务端；"ok" 两侧一致；"skipped" 不满足条件。
 */
export async function reconcilePushSubscription(
  reg?: ServiceWorkerRegistration,
): Promise<"resubscribed" | "synced" | "ok" | "skipped"> {
  try {
    if (!isPushWanted() || !isOfflineCacheEnabled()) return "skipped"
    if (detectPushSupport() !== "ok" || Notification.permission !== "granted") return "skipped"
    const r = reg ?? (await navigator.serviceWorker.getRegistration())
    if (!r || !r.active) return "skipped"
    const config = await getPushConfig()
    if (!config.enabled || !config.vapid_public_key) return "skipped"
    const existing = await r.pushManager.getSubscription()
    if (existing) {
      if (config.subscriptions.some((s) => s.endpoint === existing.endpoint)) return "ok"
      await syncSubscription(existing)
      return "synced"
    }
    const sub = await subscribeOn(r, config.vapid_public_key)
    await syncSubscription(sub)
    return "resubscribed"
  } catch {
    return "skipped"
  }
}

/** 某个 registration 上是否挂着推送订阅（SW 自愈/清理前用来决定要不要保住它）。 */
export async function registrationHasPush(reg: ServiceWorkerRegistration): Promise<boolean> {
  try {
    return (await reg.pushManager.getSubscription()) !== null
  } catch {
    return false
  }
}
