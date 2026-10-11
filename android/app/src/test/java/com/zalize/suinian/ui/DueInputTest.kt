package com.zalize.suinian.ui

import com.zalize.suinian.ui.components.DueInput
import com.zalize.suinian.ui.components.dueToInput
import com.zalize.suinian.ui.components.inputToDue
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId

class DueInputTest {

    private val shanghai = ZoneId.of("Asia/Shanghai")
    private val newYork = ZoneId.of("America/New_York")

    @Test
    fun `server value is shown as device local wall clock`() {
        assertEquals("2026-09-12 18:00", dueToInput("2026-09-12T18:00:00+08:00", shanghai))
        assertEquals("2026-09-12 06:00", dueToInput("2026-09-12T18:00:00+08:00", newYork))
        assertEquals("2026-09-12 18:00", dueToInput("2026-09-12T10:00:00Z", shanghai))
        assertEquals("2026-09-12", dueToInput("2026-09-12", newYork))
        assertEquals("", dueToInput(null, shanghai))
        assertEquals("", dueToInput("  ", shanghai))
    }

    @Test
    fun `bare wall clock gets the device offset at that instant`() {
        assertEquals(DueInput.Value("2026-09-12T18:00:00+08:00"), inputToDue("2026-09-12 18:00", shanghai))
        assertEquals(DueInput.Value("2026-09-12T18:00:00-04:00"), inputToDue("2026-09-12 18:00", newYork))
        assertEquals(DueInput.Value("2026-12-12T18:00:00-05:00"), inputToDue("2026-12-12T18:00", newYork))
        assertEquals(DueInput.Value("2026-09-12T18:00:00+00:00"), inputToDue(" 2026-09-12 18:00 ", ZoneId.of("UTC")))
    }

    @Test
    fun `round trip keeps the same instant across zones`() {
        val stored = "2026-09-12T18:00:00+08:00"
        val shown = dueToInput(stored, newYork)
        assertEquals(DueInput.Value("2026-09-12T06:00:00-04:00"), inputToDue(shown, newYork))
    }

    @Test
    fun `date only and full iso pass through untouched`() {
        assertEquals(DueInput.Value("2026-09-12"), inputToDue("2026-09-12", newYork))
        assertEquals(DueInput.Value("2026-09-12T18:00:00+08:00"), inputToDue("2026-09-12T18:00:00+08:00", newYork))
        assertEquals(DueInput.Value("2026-09-12T10:00:00Z"), inputToDue("2026-09-12T10:00:00Z", newYork))
    }

    @Test
    fun `blank clears`() {
        assertEquals(DueInput.Empty, inputToDue("", shanghai))
        assertEquals(DueInput.Empty, inputToDue("   ", shanghai))
    }

    @Test
    fun `unsupported shapes are rejected before reaching the server`() {
        for (bad in listOf("明天下午", "2026/09/12 18:00", "9月12日 18:00", "2026-9-12 18:00", "2026-09-12 6pm", "2026-13-01", "2026-09-31", "2026-09-12 25:00")) {
            assertEquals(bad, DueInput.Invalid, inputToDue(bad, shanghai))
        }
    }
}
