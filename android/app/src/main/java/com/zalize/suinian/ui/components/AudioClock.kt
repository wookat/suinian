package com.zalize.suinian.ui.components

/** 语音时长 / 进度的「m:ss」文案；超过一小时进位到「h:mm:ss」。非法 / 未知值返回 null 由调用方省略 */
fun formatAudioClock(ms: Long?): String? {
    if (ms == null || ms < 0) return null
    val totalSec = (ms + 500) / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** 播放进度 0f..1f；时长未知或为 0 返回 null（不画进度条） */
fun audioProgress(positionMs: Long, durationMs: Long?): Float? {
    if (durationMs == null || durationMs <= 0) return null
    return (positionMs.toFloat() / durationMs).coerceIn(0f, 1f)
}

private val AUDIO_EXT_BY_MIME = mapOf(
    "audio/amr" to "amr",
    "audio/amr-wb" to "awb",
    "audio/3gpp" to "3gp",
    "audio/mp4" to "m4a",
    "audio/x-m4a" to "m4a",
    "audio/aac" to "aac",
    "audio/mpeg" to "mp3",
    "audio/mp3" to "mp3",
    "audio/ogg" to "ogg",
    "audio/opus" to "opus",
    "audio/webm" to "webm",
    "audio/wav" to "wav",
    "audio/x-wav" to "wav",
    "audio/wave" to "wav",
    "audio/flac" to "flac",
    "audio/x-flac" to "flac",
)

private val IMAGE_EXT_BY_MIME = mapOf(
    "image/jpeg" to "jpg",
    "image/jpg" to "jpg",
    "image/png" to "png",
    "image/webp" to "webp",
    "image/gif" to "gif",
    "image/heic" to "heic",
    "image/heif" to "heif",
    "image/bmp" to "bmp",
)

/**
 * 附件原件的下载 / 分享文件名：服务端给的附件名优先（web「下载原件」同口径）；没有扩展名时按 mime 补一个，
 * 让系统下载目录 / 其他应用能按后缀识别；完全没名字时用 <fallbackPrefix>-<noteId 前 8 位>。
 */
fun attachmentDownloadName(attachmentName: String, mime: String?, noteId: String, fallbackPrefix: String): String {
    val base = attachmentName.trim().ifEmpty { "$fallbackPrefix-${noteId.take(8)}" }
    if (base.substringAfterLast('.', "").let { it.isNotEmpty() && it.length <= 5 && it.all { c -> c.isLetterOrDigit() } }) return base
    val m = mime?.lowercase()?.substringBefore(';')?.trim()
    val ext = m?.let { AUDIO_EXT_BY_MIME[it] ?: IMAGE_EXT_BY_MIME[it] }
    return if (ext != null) "$base.$ext" else base
}

fun audioDownloadName(attachmentName: String, mime: String?, noteId: String): String =
    attachmentDownloadName(attachmentName, mime, noteId, "voice")

/** 语音卡文字：未播过只显示时长；播放 / 暂停中显示「已播 / 总长」 */
fun audioClockLabel(playing: Boolean, inProgress: Boolean, position: String?, total: String?): String = when {
    inProgress && total != null -> "${if (playing) "播放中" else "已暂停"} ${position ?: "0:00"} / $total"
    inProgress -> "${if (playing) "播放中" else "已暂停"} ${position ?: "0:00"}"
    total != null -> "语音 $total"
    else -> "播放原始语音"
}
