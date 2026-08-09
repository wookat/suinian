package com.zalize.suinian.reminder

import com.zalize.suinian.data.Note
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class ReminderLogicTest {

    private fun note(id: String, due: String?, done: Boolean? = false) = Note(
        id = id,
        content = "test",
        todoDue = due,
        todoDone = done,
        createdAt = "2026-01-01 00:00:00",
    )

    @Test
    fun `due todos include past and now, exclude future`() {
        val now = Instant.parse("2026-01-05T04:00:00Z") // 12:00 北京时间
        val notes = listOf(
            note("past", "2026-01-05 11:00"),
            note("future", "2026-01-05 13:00"),
            note("done", "2026-01-05 11:00", done = true),
            note("nodue", null),
        )
        assertEquals(listOf("past"), dueTodos(notes, now).map { it.id })
    }

    @Test
    fun `due parsing supports offset format`() {
        val now = Instant.parse("2026-01-05T04:00:00Z")
        val notes = listOf(note("a", "2026-01-05T03:30:00+00:00"))
        assertEquals(listOf("a"), dueTodos(notes, now).map { it.id })
    }

    @Test
    fun `reminder key changes when due changes`() {
        val a = todoReminderKey(note("n1", "2026-01-05 11:00"))
        val b = todoReminderKey(note("n1", "2026-01-05 12:00"))
        assertEquals(false, a == b)
        assertEquals(a, todoReminderKey(note("n1", "2026-01-05 11:00")))
    }

    @Test
    fun `review key is per date`() {
        assertEquals("review:2026-01-05", reviewReminderKey("2026-01-05"))
    }
}
