import { useEffect, useState } from "react"

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

/** Build-time API base (e.g. VITE_API_BASE=http://127.0.0.1:8787 for local dev).
 * A localhost value is honored only when the page itself is served from
 * localhost, so a stray .env.local can never leak into a deployed build. */
const ENV_API_BASE = (() => {
  const v = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? ""
  const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(v)
  const onLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  return isLocalUrl && !onLocalhost ? "" : v
})()

/** Suggested API base for register/login forms: saved value, build-time env,
 * or the official instance when the page is served from the hosted domain. */
export function defaultApiBase(): string {
  const saved = loadSettings().apiBaseUrl.trim()
  if (saved) return saved
  if (ENV_API_BASE) return ENV_API_BASE
  if (window.location.hostname.endsWith("zalize.com")) return OFFICIAL_API_BASE
  return ""
}

const KEY = "suinian.settings"

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        apiBaseUrl: parsed.apiBaseUrl || ENV_API_BASE,
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
  return { apiBaseUrl: ENV_API_BASE, apiToken: "", useMock: true, onboarded: false, tourSeen: true }
}

export const SETTINGS_CHANGED_EVENT = "suinian:settings-changed"

export function saveSettings(s: Settings) {
  localStorage.setItem(KEY, JSON.stringify(s))
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
