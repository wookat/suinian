import { useEffect, useRef, useState } from "react"
import { Mic, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"

/** 与后端 10MB 上限对齐：Opus ~32kbps，10 分钟约 2.4MB，留足余量 */
export const MAX_RECORD_SECONDS = 10 * 60

function pickMimeType(): string {
  // Safari/iOS 只支持 mp4/aac；Chromium/Firefox 走 webm/opus
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t
  }
  return ""
}

export function voiceSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia
}

/**
 * 录音按钮（P2-1）：MediaRecorder 录音，停止后把音频 File 交给 onRecorded，
 * 走既有 /api/ingest/media 语音转写管线。移动优先：录音中显示计时 + 取消/发送。
 */
export function VoiceRecorder({
  onRecorded,
  onError,
  disabled,
}: {
  onRecorded: (file: File) => void
  onError: (message: string) => void
  disabled?: boolean
}) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      const r = recorderRef.current
      if (r && r.state !== "inactive") {
        cancelledRef.current = true
        r.stop()
        r.stream.getTracks().forEach((t) => t.stop())
      }
    }
  }, [])

  async function start() {
    if (recording || disabled) return
    if (!voiceSupported()) {
      onError("当前浏览器不支持录音")
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      onError("无法访问麦克风：请在浏览器设置中允许麦克风权限")
      return
    }
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    cancelledRef.current = false
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
      setRecording(false)
      setSeconds(0)
      if (cancelledRef.current) return
      const type = recorder.mimeType || mimeType || "audio/webm"
      const blob = new Blob(chunksRef.current, { type })
      if (blob.size === 0) {
        onError("没有录到声音，请重试")
        return
      }
      const ext = type.includes("mp4") ? "m4a" : "webm"
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      onRecorded(new File([blob], `voice-${stamp}.${ext}`, { type }))
    }
    recorderRef.current = recorder
    recorder.start()
    setRecording(true)
    setSeconds(0)
    timerRef.current = window.setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_RECORD_SECONDS) stop(false)
        return s + 1
      })
    }, 1000)
  }

  function stop(cancel: boolean) {
    const r = recorderRef.current
    if (!r || r.state === "inactive") return
    cancelledRef.current = cancel
    r.stop()
  }

  if (recording) {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0")
    const ss = String(seconds % 60).padStart(2, "0")
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
          <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden />
          <span className="tabular-nums">
            {mm}:{ss}
          </span>
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-11 min-w-11 sm:h-8 sm:min-w-0"
          onClick={() => stop(true)}
          aria-label="取消录音"
          title="取消录音"
        >
          <X />
        </Button>
        <Button
          size="sm"
          className="h-11 min-w-11 sm:h-8 sm:min-w-0"
          onClick={() => stop(false)}
          aria-label="停止并发送录音"
          title="停止并发送，AI 转写为文字"
        >
          <Square />
        </Button>
      </div>
    )
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-11 min-w-11 sm:h-8 sm:min-w-0"
      onClick={() => void start()}
      disabled={disabled}
      aria-label="录音，AI 转写为文字"
      title="录音，AI 转写为文字"
    >
      <Mic />
    </Button>
  )
}
