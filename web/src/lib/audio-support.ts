import type { NoteAttachment } from "@/lib/types"

/** `canPlayType` 返回空串 = 浏览器明确不支持该 MIME（如 Chrome/Firefox 对 audio/amr）；未知 MIME 交给浏览器嗅探。 */
export function browserCanPlayAudio(mime: string | null): boolean {
  if (!mime || typeof document === "undefined") return true
  const probe = document.createElement("audio")
  if (typeof probe.canPlayType !== "function") return true
  return probe.canPlayType(mime) !== ""
}

export function audioFormatLabel(a: NoteAttachment): string {
  const dot = a.name.lastIndexOf(".")
  const ext = dot > 0 ? a.name.slice(dot + 1).trim().toLowerCase() : ""
  if (ext && ext.length <= 5) return ext
  const sub = a.mime?.split("/")[1]?.split(";")[0]?.trim().toLowerCase()
  return sub || "该"
}

export function unplayableAudioText(format: string): string {
  const origin = format === "amr" ? "（微信语音的原始格式）" : ""
  return `当前浏览器不能播放 ${format} 格式的语音${origin}，可下载原件后用手机播放。`
}
