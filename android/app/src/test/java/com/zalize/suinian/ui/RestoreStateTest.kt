package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestoreStateTest {
    @Test
    fun percent_and_label_during_upload() {
        val s = RestoreState.Running(sent = 3 * 1024 * 1024L, total = 12 * 1024 * 1024L)
        assertFalse(s.uploaded)
        assertEquals(25, restorePercent(s))
        assertEquals("上传中 3.0MB / 12.0MB（25%）", restoreProgressLabel(s))
    }

    @Test
    fun uploaded_switches_to_server_import_label() {
        val s = RestoreState.Running(sent = 12 * 1024 * 1024L, total = 12 * 1024 * 1024L)
        assertTrue(s.uploaded)
        assertEquals(100, restorePercent(s))
        assertTrue(restoreProgressLabel(s).startsWith("上传完成，服务端导入中"))
    }

    @Test
    fun percent_clamps_and_handles_unknown_total() {
        assertEquals(0, restorePercent(RestoreState.Running(0, 0)))
        assertEquals(100, restorePercent(RestoreState.Running(20, 10)))
    }

    @Test
    fun cancel_message_depends_on_whether_upload_finished() {
        assertEquals(RESTORE_CANCELLED_DURING_UPLOAD, restoreCancelledMessage(RestoreState.Reading))
        assertEquals(RESTORE_CANCELLED_DURING_UPLOAD, restoreCancelledMessage(RestoreState.Running(1, 10)))
        assertEquals(RESTORE_CANCELLED_AFTER_UPLOAD, restoreCancelledMessage(RestoreState.Running(10, 10)))
        assertTrue(RESTORE_CANCELLED_DURING_UPLOAD.contains("服务端不会导入"))
        assertTrue(RESTORE_CANCELLED_AFTER_UPLOAD.contains("自动跳过"))
    }
}
