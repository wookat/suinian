package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class TrashRemainingLabelTest {

    private val now: Instant = Instant.parse("2026-08-09T00:00:00Z")

    @Test
    fun `days remaining`() {
        assertEquals("剩 29 天", trashRemainingLabel("2026-09-07 12:00:00", now))
    }

    @Test
    fun `hours remaining under a day`() {
        assertEquals("剩 5 小时", trashRemainingLabel("2026-08-09 05:30:00", now))
    }

    @Test
    fun `under an hour`() {
        assertEquals("剩不足 1 小时", trashRemainingLabel("2026-08-09 00:30:00", now))
    }

    @Test
    fun `expired shows imminent cleanup`() {
        assertEquals("即将清理", trashRemainingLabel("2026-08-08 23:00:00", now))
    }

    @Test
    fun `blank or bad input is empty`() {
        assertEquals("", trashRemainingLabel(null, now))
        assertEquals("", trashRemainingLabel("", now))
    }
}
