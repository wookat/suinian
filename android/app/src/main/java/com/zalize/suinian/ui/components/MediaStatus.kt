package com.zalize.suinian.ui.components

import com.zalize.suinian.data.Note

/** 语音 / 图片 / 文件笔记的原件提取状态行（对齐 web note-card 的 mediaFailed / mediaSuspect 口径） */
data class MediaStatusLine(
    val text: String,
    /** true = 提取失败（正文是占位）；false = 提取存疑（正文可用但建议核对） */
    val failed: Boolean,
    /** 原地重试成功后的提示 */
    val doneToast: String,
)

/**
 * 服务端 POST /api/notes/:id/retry-media 接受的四种状态：voice / image 的 media_status=extract_failed、
 * transcript_suspect / ocr_suspect，file 的 file_status=extract_failed；历史失败笔记只有正文占位前缀、无 media_status。
 */
fun mediaStatusLine(note: Note): MediaStatusLine? {
    val meta = note.meta
    return when (note.rawType) {
        "voice" -> when {
            meta?.mediaStatus == "extract_failed" || note.content.startsWith("【语音】转写失败") ->
                MediaStatusLine("转写失败，原件已存档", failed = true, doneToast = "已重新转写")
            meta?.transcriptSuspect == true ->
                MediaStatusLine("转写可能不准，建议核对", failed = false, doneToast = "已重新转写")
            else -> null
        }
        "image" -> when {
            meta?.mediaStatus == "extract_failed" || note.content.startsWith("【图片】文字提取失败") ->
                MediaStatusLine("文字提取失败，原件已存档", failed = true, doneToast = "已重新识别")
            meta?.ocrSuspect == true ->
                MediaStatusLine("文字识别可能不准，建议核对原图", failed = false, doneToast = "已重新识别")
            else -> null
        }
        "file" -> if (meta?.fileStatus == "extract_failed") {
            MediaStatusLine("文本提取失败，原件已存档", failed = true, doneToast = "已重新提取")
        } else null
        else -> null
    }
}
