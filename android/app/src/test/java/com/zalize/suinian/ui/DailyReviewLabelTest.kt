package com.zalize.suinian.ui

import com.zalize.suinian.ui.components.reviewDateLabel
import org.junit.Assert.assertEquals
import org.junit.Test

class DailyReviewLabelTest {

    @Test
    fun `ISO date renders as Chinese date`() {
        assertEquals("2024年8月7日", reviewDateLabel("2024-08-07"))
    }

    @Test
    fun `datetime keeps date part`() {
        assertEquals("2025年12月31日", reviewDateLabel("2025-12-31T23:59:00Z"))
    }

    @Test
    fun `unparseable input falls back to first 10 chars`() {
        assertEquals("not-a-date", reviewDateLabel("not-a-date-at-all"))
    }
}
