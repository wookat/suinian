package com.zalize.suinian.ui

import com.zalize.suinian.data.Note
import com.zalize.suinian.data.RestoreStats
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestoreSummaryTest {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    /** 本机 Worker POST /api/backup/restore 实录：脱敏备份恢复到新账号 */
    private val redactedRestore = """
        {"notes_total":4,"notes_imported":2,"notes_skipped":0,"sensitive_skipped":2,
         "reports_imported":0,"reports_skipped":0,"threads_rebuilt":0,
         "media_imported":0,"media_skipped":0,"media_oversized":0,"media_failed":0,
         "media_missing":0,"media_missing_notes":[]}
    """.trimIndent()

    /** 本机 Worker 实录：zip 里缺 pic.png、blob.bin 超限 */
    private val mixedRestore = """
        {"notes_total":4,"notes_imported":4,"notes_skipped":0,"sensitive_skipped":0,
         "reports_imported":0,"reports_skipped":0,"threads_rebuilt":0,
         "media_imported":2,"media_skipped":0,"media_oversized":1,"media_failed":0,
         "media_missing":1,"media_missing_notes":[
           {"note_id":"1d11a4e2-d4b4-4855-b961-cf7e95ca6010","name":"blob.bin","reason":"oversized"},
           {"note_id":"3022692d-6da2-4fc3-8570-d400efc4c7d4","name":"pic.png","reason":"missing"}]}
    """.trimIndent()

    @Test
    fun `decodes new restore stats fields`() {
        val stats = json.decodeFromString<RestoreStats>(mixedRestore)
        assertEquals(1, stats.mediaOversized)
        assertEquals(1, stats.mediaMissing)
        assertEquals(listOf("blob.bin", "pic.png"), stats.mediaMissingNotes.map { it.name })
        assertEquals(listOf("oversized", "missing"), stats.mediaMissingNotes.map { it.reason })
        assertEquals(2, json.decodeFromString<RestoreStats>(redactedRestore).sensitiveSkipped)
    }

    @Test
    fun `old server response without new fields still decodes`() {
        val stats = json.decodeFromString<RestoreStats>(
            """{"notes_total":3,"notes_imported":3,"notes_skipped":0,"media_imported":1,"media_skipped":0,"media_failed":0}"""
        )
        assertEquals(0, stats.sensitiveSkipped)
        assertEquals(0, stats.mediaMissing)
        assertTrue(stats.mediaMissingNotes.isEmpty())
        assertEquals(
            "恢复完成：笔记 3/3 条（跳过重复 0 条），媒体 1 个。AI 分拣/线索/图谱会在后台陆续补全",
            restoreSummary(stats),
        )
    }

    @Test
    fun `summary tells user sensitive notes were skipped`() {
        val text = restoreSummary(json.decodeFromString<RestoreStats>(redactedRestore))
        assertTrue(text, text.contains("笔记 2/4 条"))
        assertTrue(text, text.contains("跳过脱敏占位的敏感笔记 2 条"))
        assertTrue(text, text.contains("包含敏感内容"))
        assertFalse(text, text.contains("原件没跟上"))
    }

    @Test
    fun `summary lists missing originals with names and reasons`() {
        val text = restoreSummary(json.decodeFromString<RestoreStats>(mixedRestore))
        assertTrue(text, text.contains("媒体 2 个，超过大小上限跳过 1 个，备份包里缺少 1 个"))
        assertTrue(text, text.contains("2 个原件没跟上（blob.bin、pic.png）"))
        assertFalse(text, text.contains(" 等）"))
        assertTrue(text, text.contains("重新上传"))
        assertTrue(text, text.endsWith("AI 分拣/线索/图谱会在后台陆续补全"))
    }

    @Test
    fun `summary caps listed names at five and appends etc`() {
        val stats = RestoreStats(
            notesTotal = 8, notesImported = 8, mediaImported = 1, mediaFailed = 7,
            mediaMissingNotes = (1..7).map { com.zalize.suinian.data.RestoreMissingMedia("n$it", "f$it.png", "failed") },
        )
        val text = restoreSummary(stats)
        assertTrue(text, text.contains("存档失败 7 个"))
        assertTrue(text, text.contains("7 个原件没跟上（f1.png、f2.png、f3.png、f4.png、f5.png 等）"))
    }

    @Test
    fun `note meta attachment_missing decodes and maps to hint`() {
        val note = json.decodeFromString<Note>(
            """{"id":"1d11a4e2","raw_type":"file","content":"x","created_at":"2026-09-08T00:00:00Z",
                "meta":{"file_name":"blob.bin","file_mime":"application/octet-stream","attachment_missing":"oversized"}}"""
        )
        assertEquals("oversized", note.meta?.attachmentMissing)
        assertEquals("原件未随备份恢复（超过单文件大小上限），需要原件请重新上传", attachmentMissingText(note.meta?.attachmentMissing))
        assertEquals("原件未随备份恢复（存档失败），需要原件请重新上传", attachmentMissingText("failed"))
        assertEquals("原件未随备份恢复（备份包里没有这个文件），需要原件请重新上传", attachmentMissingText("missing"))
        assertNull(attachmentMissingText(null))
        assertNull(attachmentMissingText(""))
    }
}
