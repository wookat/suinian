import { useEffect, useState } from "react"
import { scrubApiCacheForToken } from "./api-cache"

export interface Settings {
  apiBaseUrl: string
  apiToken: string
  useMock: boolean
  /** true once the user has made a first-run choice (demo / token / register) */
  onboarded: boolean
  /** true once the first-entry feature tour was shown or skipped (only false right after registering) */
  tourSeen: boolean
}

const OFFICIAL_API_BASE = "https://suinian-api.zalize.com"

/** True when `url` points at the official hosted instance. */
export function isOfficialApiBase(url: string): boolean {
  try {
    return new URL(url).host === new URL(OFFICIAL_API_BASE).host
  } catch {
    return false
  }
}

/** Build-time API base (e.g. VITE_API_BASE=http://127.0.0.1:8787 for local dev).
 * A localhost value is honored only when the page itself is served from
 * localhost, so a stray .env.local can never leak into a deployed build. */
const ENV_API_BASE = (() => {
  const v = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? ""
  const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(v)
  const onLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  return isLocalUrl && !onLocalhost ? "" : v
})()

/** API base used when nothing is saved: build-time env, or the official
 * instance when the page is served from the hosted domain. */
const FALLBACK_API_BASE =
  ENV_API_BASE || (window.location.hostname.endsWith("zalize.com") ? OFFICIAL_API_BASE : "")

/** Effective API base for register/login forms and every real-API request:
 * saved value, else the hosted/build-time fallback. */
export function defaultApiBase(): string {
  return loadSettings().apiBaseUrl.trim()
}

const KEY = "suinian.settings"

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        apiBaseUrl: parsed.apiBaseUrl || FALLBACK_API_BASE,
        apiToken: parsed.apiToken ?? "",
        useMock: parsed.useMock ?? true,
        // existing installs with a token already made their choice
        onboarded: parsed.onboarded ?? !!parsed.apiToken,
        // existing installs never get the tour retroactively
        tourSeen: parsed.tourSeen ?? true,
      }
    }
  } catch {
    // ignore corrupted settings
  }
  return { apiBaseUrl: FALLBACK_API_BASE, apiToken: "", useMock: true, onboarded: false, tourSeen: true }
}

export const SETTINGS_CHANGED_EVENT = "suinian:settings-changed"

export function saveSettings(s: Settings) {
  const prevToken = loadSettings().apiToken
  localStorage.setItem(KEY, JSON.stringify(s))
  // 换号/登出/登录时清掉不属于新身份的 SW api 缓存（R166 P1）
  if (s.apiToken !== prevToken) void scrubApiCacheForToken(s.apiToken)
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
}

/**
 * Bumps whenever settings change (save in this tab or storage from another
 * tab). Use as an effect dependency to refetch from the current data source.
 */
export function useSettingsVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1)
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    window.addEventListener("storage", onChange)
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
      window.removeEventListener("storage", onChange)
    }
  }, [])
  return version
}
