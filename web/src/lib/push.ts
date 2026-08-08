// Browser-side Web Push helpers: permission, subscribe/unsubscribe against the
// registered PWA service worker, syncing the subscription to the backend.
import { getPushConfig, subscribePush, unsubscribePush } from "./api"

export type PushSupport = "ok" | "unsupported" | "ios-needs-install"

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

/** Request permission, subscribe with the server's VAPID key, and sync to the backend. */
export async function enablePush(): Promise<void> {
  const config = await getPushConfig()
  if (!config.enabled || !config.vapid_public_key) throw new Error("服务端未配置推送（VAPID）")
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new Error("通知权限被拒绝，请在浏览器设置中允许本站通知后重试")
  const reg = await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(config.vapid_public_key) as BufferSource,
    }))
  const json = sub.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("订阅数据不完整")
  await subscribePush({
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    ua: deviceLabel(),
  })
}

/** Unsubscribe this browser and remove it from the backend. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  await unsubscribePush(endpoint)
}
