import { useEffect, useState } from "react"

/**
 * 把已拉到的 object URL 读成 `File` 供 Web Share API Level 2 分享；浏览器不支持文件分享时返回 null（调用方不渲染入口）。
 * 提前读好是因为 Safari 要求 `navigator.share` 在用户手势内同步调用，点击时再 fetch 会被拒。
 */
export function useShareFile(src: string | null, name: string, mime: string | null): File | null {
  const [file, setFile] = useState<File | null>(null)
  useEffect(() => {
    if (!src || typeof navigator.canShare !== "function" || typeof navigator.share !== "function") return
    let alive = true
    fetch(src)
      .then((r) => r.blob())
      .then((blob) => {
        const f = new File([blob], name, { type: mime || blob.type })
        if (alive && navigator.canShare({ files: [f] })) setFile(f)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      setFile(null)
    }
  }, [src, name, mime])
  return file
}

/** 用户手势内同步触发；用户取消（AbortError）不算失败 */
export function shareFile(file: File, title: string): void {
  navigator.share({ files: [file], title }).catch(() => undefined)
}
