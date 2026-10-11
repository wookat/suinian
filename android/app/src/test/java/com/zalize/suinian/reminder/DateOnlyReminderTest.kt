package com.zalize.suinian.reminder

import com.zalize.suinian.data.Note
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

class DateOnlyReminderTest {

    private fun note(id: String, due: String?, done: Boolean? = false) = Note(
        id = id,
        content = "test",
        todoDue = due,
        todoDone = done,
        createdAt = "2026-01-01 00:00:00",
    )

    private fun localInstant(date: String, time: String, zone: ZoneId): Instant =
        LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(zone).toInstant()

    private val zones = listOf("Asia/Shanghai", "America/New_York", "UTC").map(ZoneId::of)

    @Test
    fun `date-only todo does not remind at midnight`() {
        for (zone in zones) {
            val notes = listOf(note("d", "2026-01-05"))
            assertEquals(zone.id, emptyList<String>(), dueTodos(notes, localInstant("2026-01-05", "00:15", zone), zone).map { it.id })
            assertEquals(zone.id, emptyList<String>(), dueTodos(notes, localInstant("2026-01-05", "08:59", zone), zone).map { it.id })
        }
    }

    @Test
    fun `date-only todo reminds from 09_00 local on the due day and stays due afterwards`() {
        for (zone in zones) {
            val notes = listOf(note("d", "2026-01-05"))
            assertEquals(zone.id, listOf("d"), dueTodos(notes, localInstant("2026-01-05", "09:00", zone), zone).map { it.id })
            assertEquals(zone.id, listOf("d"), dueTodos(notes, localInstant("2026-01-05", "23:30", zone), zone).map { it.id })
            assertEquals(zone.id, listOf("d"), dueTodos(notes, localInstant("2026-01-06", "00:10", zone), zone).map { it.id })
        }
    }

    @Test
    fun `date-only todo due tomorrow is not due today`() {
        for (zone in zones) {
            val notes = listOf(note("d", "2026-01-06"))
            assertEquals(zone.id, emptyList<String>(), dueTodos(notes, localInstant("2026-01-05", "23:59", zone), zone).map { it.id })
        }
    }

    @Test
    fun `timed todos keep firing exactly at their instant`() {
        val zone = ZoneId.of("America/New_York")
        val notes = listOf(
            note("legacy", "2026-01-05 11:00"), // +08:00 = 03:00Z
            note("offset", "2026-01-05T10:00:00-05:00"), // 15:00Z
        )
        assertEquals(listOf("legacy"), dueTodos(notes, Instant.parse("2026-01-05T03:00:00Z"), zone).map { it.id })
        assertEquals(listOf("legacy", "offset"), dueTodos(notes, Instant.parse("2026-01-05T15:00:00Z"), zone).map { it.id })
    }
}
