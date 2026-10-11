package com.zalize.suinian.ui.components

import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NoteMeta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 原件提取状态行判定：与 web note-card mediaFailed / mediaSuspect、服务端 retry-media 接受的四种状态同口径 */
class MediaStatusTest {

    private fun note(rawType: String, content: String, meta: NoteMeta? = null) = Note(
        id = "n1",
        content = content,
        rawType = rawType,
        createdAt = "2026-09-08T10:00:00Z",
        meta = meta,
    )

    @Test
    fun voiceExtractFailedByMetaOrPlaceholder() {
        val byMeta = mediaStatusLine(note("voice", "随便什么正文", NoteMeta(mediaStatus = "extract_failed")))
        assertEquals("转写失败，原件已存档", byMeta?.text)
        assertTrue(byMeta!!.failed)
        // 历史失败笔记只有正文占位、无 media_status（服务端 AUDIO_FAILED_PLACEHOLDER）
        val byPlaceholder = mediaStatusLine(note("voice", "【语音】转写失败，稍后可重发"))
        assertEquals("转写失败，原件已存档", byPlaceholder?.text)
        assertTrue(byPlaceholder!!.failed)
    }

    @Test
    fun imageExtractFailedByMetaOrPlaceholder() {
        assertEquals(
            "文字提取失败，原件已存档",
            mediaStatusLine(note("image", "x", NoteMeta(mediaStatus = "extract_failed")))?.text,
        )
        assertEquals(
            "文字提取失败，原件已存档",
            mediaStatusLine(note("image", "【图片】文字提取失败，稍后可重发"))?.text,
        )
    }

    @Test
    fun suspectIsNotFailed() {
        val voice = mediaStatusLine(note("voice", "转写正文", NoteMeta(transcriptSuspect = true)))
        assertEquals("转写可能不准，建议核对", voice?.text)
        assertFalse(voice!!.failed)
        val image = mediaStatusLine(note("image", "识别正文", NoteMeta(ocrSuspect = true)))
        assertEquals("文字识别可能不准，建议核对原图", image?.text)
        assertFalse(image!!.failed)
    }

    @Test
    fun failedWinsOverSuspect() {
        val s = mediaStatusLine(note("voice", "x", NoteMeta(mediaStatus = "extract_failed", transcriptSuspect = true)))
        assertTrue(s!!.failed)
    }

    @Test
    fun fileExtractFailed() {
        val s = mediaStatusLine(note("file", "x", NoteMeta(fileName = "a.pdf", fileStatus = "extract_failed")))
        assertEquals("文本提取失败，原件已存档", s?.text)
        assertTrue(s!!.failed)
        assertNull(mediaStatusLine(note("file", "x", NoteMeta(fileName = "a.pdf", fileStatus = "ok"))))
    }

    @Test
    fun okNotesHaveNoStatusLine() {
        assertNull(mediaStatusLine(note("voice", "正常转写", NoteMeta(mediaStatus = "ok"))))
        assertNull(mediaStatusLine(note("voice", "正常转写")))
        assertNull(mediaStatusLine(note("image", "正常识别", NoteMeta(imageDescription = "一张图"))))
        assertNull(mediaStatusLine(note("text", "【语音】转写失败，稍后可重发")))
        assertNull(mediaStatusLine(note("link", "x", NoteMeta(linkStatus = "fetch_failed"))))
    }
}
