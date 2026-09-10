/**
 * 全屏看图的缩放 / 拖动纯函数（与 Android ZoomMath.kt 同口径）：
 * 图片以 Fit（object-contain）尺寸居中放在容器里，变换 = 先平移 (offsetX, offsetY) 再以中心为轴放大 scale。
 */

export const IMAGE_ZOOM_MIN = 1
export const IMAGE_ZOOM_MAX = 5
export const IMAGE_ZOOM_DOUBLE_TAP = 2.5

/**
 * 放大后只允许拖到贴边为止：某一轴上放大后的图比容器短就居中不动，比容器长才能拖、拖到边缘就停。
 */
export function clampPan(
  x: number,
  y: number,
  scale: number,
  contentW: number,
  contentH: number,
  containerW: number,
  containerH: number,
): [number, number] {
  const maxX = Math.max(0, (contentW * scale - containerW) / 2)
  const maxY = Math.max(0, (contentH * scale - containerH) / 2)
  return [Math.min(maxX, Math.max(-maxX, x)), Math.min(maxY, Math.max(-maxY, y))]
}

/**
 * 以 focus（相对容器中心的坐标）为轴从 oldScale 变到 newScale，轴下面的那块内容保持不动。
 */
export function zoomAboutFocus(
  offsetX: number,
  offsetY: number,
  oldScale: number,
  newScale: number,
  focusX: number,
  focusY: number,
): [number, number] {
  const k = newScale / oldScale
  return [focusX - (focusX - offsetX) * k, focusY - (focusY - offsetY) * k]
}

export function clampScale(s: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, s))
}

/** 双击：放大了就复原，没放大就放到 2.5x */
export function nextDoubleTapScale(current: number): number {
  return current > 1.01 ? 1 : IMAGE_ZOOM_DOUBLE_TAP
}

/**
 * 滚轮一格 → 倍率：向上滚放大。deltaY 按像素（DOM_DELTA_PIXEL）计，100px ≈ ×1.22；
 * 按行 / 页计的滚轮先折成像素再算。
 */
export function wheelScale(current: number, deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return clampScale(current * Math.exp(-px * 0.002))
}
