import { useEffect, useState } from "react"

export interface Settings {
  apiBaseUrl: string
  apiToken: string
  useMock: boolean
}

const KEY = "suinian.settings"

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        apiBaseUrl: parsed.apiBaseUrl ?? "",
        apiToken: parsed.apiToken ?? "",
        useMock: parsed.useMock ?? true,
      }
    }
  } catch {
    // ignore corrupted settings
  }
  return { apiBaseUrl: "", apiToken: "", useMock: true }
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
