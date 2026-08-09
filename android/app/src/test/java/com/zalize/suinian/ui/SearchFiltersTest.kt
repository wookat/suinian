package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class SearchFiltersTest {

    private val shanghai = ZoneId.of("Asia/Shanghai")

    @Test
    fun `local date start converts to utc sql`() {
        // 北京时间 2026-01-05 00:00 = UTC 2026-01-04 16:00
        assertEquals(
            "2026-01-04 16:00:00",
            localDateStartToUtcSql(LocalDate.of(2026, 1, 5), shanghai),
        )
    }

    @Test
    fun `time range presets compute from param`() {
        val today = LocalDate.of(2026, 1, 30)
        assertEquals("2026-01-29 16:00:00", TimeRange.TODAY.fromParam(today, shanghai))
        assertEquals("2026-01-23 16:00:00", TimeRange.WEEK.fromParam(today, shanghai))
        assertEquals("2025-12-31 16:00:00", TimeRange.MONTH.fromParam(today, shanghai))
    }
}
