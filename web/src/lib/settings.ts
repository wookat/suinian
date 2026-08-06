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
