package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ReportLabelTest {

    @Test
    fun `week report uses week label`() {
        assertEquals("8 月 3 日那周", reportLabel("week", "2026-08-03"))
    }

    @Test
    fun `month report uses year-month label`() {
        assertEquals("2026 年 7 月", reportLabel("month", "2026-07-01"))
    }

    @Test
    fun `invalid date falls back to raw`() {
        assertEquals("bad", reportLabel("month", "bad"))
    }
}
