/**
 * 附件落盘 / 分享用的文件名：服务端原名优先；原名没有扩展名（微信语音 / 图片走 storeOriginal 时无 fileName，
 * r2_key 只剩 `<ts>-audio` / `<ts>-image`）时按 MIME 补，手机 / 桌面靠扩展名认格式打开。
 */
const AUDIO_EXT_BY_MIME: Record<string, string> = {
  "audio/amr": "amr",
  "audio/amr-wb": "awb",
  "audio/3gpp": "3gp",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
}

const EXT_RE = /\.([A-Za-z0-9]{1,5})$/

export function attachmentDownloadName(name: string, mime: string | null | undefined, fallbackBase: string): string {
  const base = name.trim() || fallbackBase
  if (EXT_RE.test(base)) return base
  const m = mime?.toLowerCase().split(";")[0]?.trim() ?? ""
  const ext = AUDIO_EXT_BY_MIME[m] ?? IMAGE_EXT_BY_MIME[m]
  return ext ? `${base}.${ext}` : base
}
