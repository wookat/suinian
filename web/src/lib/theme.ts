export type ThemeMode = "light" | "dark" | "system"

const KEY = "suinian.theme"
const media = window.matchMedia("(prefers-color-scheme: dark)")

export function loadTheme(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

const THEME_COLOR = { light: "#fafafa", dark: "#18181b" }

export function applyTheme(mode: ThemeMode = loadTheme()) {
  const dark = mode === "dark" || (mode === "system" && media.matches)
  document.documentElement.classList.toggle("dark", dark)
  const color = dark ? THEME_COLOR.dark : THEME_COLOR.light
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((m) => {
      m.content = color
    })
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
