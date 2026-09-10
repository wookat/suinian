import { useCallback, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { clampPan, clampScale, nextDoubleTapScale, wheelScale, zoomAboutFocus } from "@/lib/zoom-math"

/** 点按判定：手指 / 鼠标位移小于这个值才算「点」，否则是拖 */
const TAP_SLOP_PX = 8
/** 双击窗口：单击关闭要等这么久确认不是双击 */
const DOUBLE_TAP_MS = 250

interface Pointer {
  x: number
  y: number
}

/**
 * 全屏看图：滚轮 / 双指缩放（1–5 倍）、放大后拖动（贴边为止）、双击 1x ↔ 2.5x、单击 / Esc / 右上角关闭。
 * 覆盖层 touch-action: none，浏览器自己的页面缩放不参与——否则关掉大图后整页还停在放大状态。
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<[number, number]>([0, 0])
  const [dragging, setDragging] = useState(false)
  // 手势过程态不进 React 状态：pointermove 每帧读写
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const pointers = useRef(new Map<number, Pointer>())
  const gesture = useRef<{ moved: boolean; startDist: number; startScale: number; maxPointers: number } | null>(null)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTap = useRef(0)

  const geometry = useCallback(() => {
    const el = containerRef.current
    const img = imgRef.current
    if (!el || !img) return null
    // offsetWidth/Height 是 Fit 后的排版尺寸，不受 transform 影响；容器取整个覆盖层，放大后图边可以贴到屏幕边
    return { rect: el.getBoundingClientRect(), contentW: img.offsetWidth, contentH: img.offsetHeight }
  }, [])

  const apply = useCallback(
    (nextScale: number, x: number, y: number) => {
      const g = geometry()
      const s = clampScale(nextScale)
      let nx = x
      let ny = y
      if (g) [nx, ny] = clampPan(x, y, s, g.contentW, g.contentH, g.rect.width, g.rect.height)
      view.current = { scale: s, x: nx, y: ny }
      setScale(s)
      setOffset([nx, ny])
    },
    [geometry],
  )

  /** 以视口坐标 (clientX, clientY) 为轴缩放 */
  const zoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number) => {
      const g = geometry()
      const v = view.current
      const s = clampScale(nextScale)
      if (!g) return apply(s, v.x, v.y)
      const fx = clientX - (g.rect.left + g.rect.width / 2)
      const fy = clientY - (g.rect.top + g.rect.height / 2)
      const [x, y] = zoomAboutFocus(v.x, v.y, v.scale, s, fx, fy)
      apply(s, x, y)
    },
    [apply, geometry],
  )

  const reset = useCallback(() => apply(1, 0, 0), [apply])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // React 的 onWheel 是 passive 的，拦不住浏览器页面缩放（Ctrl + 滚轮 / 触控板双指），要自己挂非 passive 监听
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomAt(wheelScale(view.current.scale, e.deltaY, e.deltaMode), e.clientX, e.clientY)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomAt])

  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current)
    },
    [],
  )

  const dist = (a: Pointer, b: Pointer) => Math.hypot(a.x - b.x, a.y - b.y)
  const mid = (a: Pointer, b: Pointer): Pointer => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const ps = [...pointers.current.values()]
    if (ps.length === 1) {
      gesture.current = { moved: false, startDist: 0, startScale: view.current.scale, maxPointers: 1 }
    } else if (ps.length === 2 && gesture.current) {
      gesture.current.maxPointers = 2
      gesture.current.startDist = dist(ps[0], ps[1])
      gesture.current.startScale = view.current.scale
    }
    if (view.current.scale > 1 || ps.length >= 2) setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId)
    const g = gesture.current
    if (!prev || !g) return
    const cur = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, cur)
    const ps = [...pointers.current.entries()]
    if (ps.length >= 2) {
      const [a, b] = [ps[0][1], ps[1][1]]
      const prevA = ps[0][0] === e.pointerId ? prev : a
      const prevB = ps[1][0] === e.pointerId ? prev : b
      const m0 = mid(prevA, prevB)
      const m1 = mid(a, b)
      const d = dist(a, b)
      if (Math.abs(d - g.startDist) > TAP_SLOP_PX || dist(m0, m1) > 0) g.moved = true
      const nextScale = g.startDist > 0 ? g.startScale * (d / g.startDist) : view.current.scale
      const v = view.current
      const geo = geometry()
      if (!geo) return
      const fx = m1.x - (geo.rect.left + geo.rect.width / 2)
      const fy = m1.y - (geo.rect.top + geo.rect.height / 2)
      const s = clampScale(nextScale)
      const [x, y] = zoomAboutFocus(v.x, v.y, v.scale, s, fx, fy)
      apply(s, x + (m1.x - m0.x), y + (m1.y - m0.y))
      return
    }
    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true
    if (g.moved && view.current.scale > 1) {
      const v = view.current
      apply(v.scale, v.x + dx, v.y + dy)
    }
  }

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const had = pointers.current.delete(e.pointerId)
    const g = gesture.current
    if (!had || !g) return
    if (pointers.current.size > 0) {
      // 双指松开一根：剩下那根继续拖，不再当点按
      g.moved = true
      return
    }
    gesture.current = null
    setDragging(false)
    if (g.moved || g.maxPointers > 1 || e.type === "pointercancel") return
    const now = Date.now()
    const x = e.clientX
    const y = e.clientY
    if (tapTimer.current && now - lastTap.current < DOUBLE_TAP_MS) {
      clearTimeout(tapTimer.current)
      tapTimer.current = null
      lastTap.current = 0
      zoomAt(nextDoubleTapScale(view.current.scale), x, y)
      return
    }
    lastTap.current = now
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null
      onClose()
    }, DOUBLE_TAP_MS)
  }

  const zoomed = scale > 1.01
  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="图片大图"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      className={cn(
        "fixed inset-0 z-50 flex touch-none select-none items-center justify-center overflow-hidden bg-black/80 p-4",
        zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-out",
      )}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={reset}
        style={{
          transform: `translate(${offset[0]}px, ${offset[1]}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: dragging ? "none" : "transform 120ms ease-out",
        }}
        className={cn("max-h-full max-w-full object-contain will-change-transform", !zoomed && "rounded-lg")}
      />
      {zoomed && (
        <span
          aria-live="polite"
          className="absolute left-4 top-4 rounded-full bg-black/50 px-2.5 py-1 text-xs tabular-nums text-white"
        >
          {Math.round(scale * 100)}% · 双击复原
        </span>
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label="关闭大图"
        className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
