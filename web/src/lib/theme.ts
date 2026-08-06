export type ThemeMode = "light" | "dark" | "system"

const KEY = "suinian.theme"
const media = window.matchMedia("(prefers-color-scheme: dark)")

export function loadTheme(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

export function applyTheme(mode: ThemeMode = loadTheme()) {
  const dark = mode === "dark" || (mode === "system" && media.matches)
  document.documentElement.classList.toggle("dark", dark)
}

export function setTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode)
  applyTheme(mode)
  window.dispatchEvent(new CustomEvent("suinian:theme", { detail: mode }))
}

export function initTheme() {
  applyTheme()
  media.addEventListener("change", () => {
    if (loadTheme() === "system") applyTheme()
  })
}
