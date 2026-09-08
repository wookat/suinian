export const COMMAND_PALETTE_EVENT = "suinian:command-palette"

let pendingOpen = false

/** 请求打开命令面板；面板组件按需加载，未挂载时记为待打开，挂载后立即弹出 */
export function openCommandPalette() {
  pendingOpen = true
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT))
}

export function consumePendingOpen(): boolean {
  const v = pendingOpen
  pendingOpen = false
  return v
}
