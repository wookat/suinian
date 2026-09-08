export type ThemeMode = "light" | "dark" | "system"

const KEY = "suinian.theme"
const media = window.matchMedia("(prefers-color-scheme: dark)")

export function loadTheme(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" ? v : "system"
}

const THEME_COLOR = { light: "#f8fafc", dark: "#0c0e12" }

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
  applyFontSize()
  media.addEventListener("change", () => {
    if (loadTheme() === "system") applyTheme()
  })
}

// ---- 四档字号（R177 P2-3）----

export type FontSize = "small" | "normal" | "large" | "xlarge"

const FONT_KEY = "suinian.fontsize"
const FONT_PX: Record<FontSize, string> = { small: "14px", normal: "16px", large: "18px", xlarge: "20px" }

export function loadFontSize(): FontSize {
  const v = localStorage.getItem(FONT_KEY)
  return v === "small" || v === "large" || v === "xlarge" ? v : "normal"
}

export function applyFontSize(size: FontSize = loadFontSize()) {
  document.documentElement.style.fontSize = size === "normal" ? "" : FONT_PX[size]
}

export function setFontSize(size: FontSize) {
  localStorage.setItem(FONT_KEY, size)
  applyFontSize(size)
}
