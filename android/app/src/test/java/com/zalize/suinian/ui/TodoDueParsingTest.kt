package com.zalize.suinian.ui

import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.parseDueInstant
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class TodoDueParsingTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `new format with offset parses to correct instant`() {
        val t = parseDueInstant("2026-08-08T15:30:00+08:00")
        assertEquals(Instant.parse("2026-08-08T07:30:00Z"), t)
    }

    @Test
    fun `legacy format without offset is interpreted as +08_00`() {
        val t = parseDueInstant("2026-08-08T15:30")
        assertEquals(Instant.parse("2026-08-08T07:30:00Z"), t)
    }

    @Test
    fun `legacy format with seconds without offset is interpreted as +08_00`() {
        val t = parseDueInstant("2026-08-08T15:30:00")
        assertEquals(Instant.parse("2026-08-08T07:30:00Z"), t)
    }

    @Test
    fun `utc format parses correctly`() {
        val t = parseDueInstant("2026-08-08T07:30:00Z")
        assertEquals(Instant.parse("2026-08-08T07:30:00Z"), t)
    }

    @Test
    fun `date only parses to local midnight`() {
        val t = parseDueInstant("2026-08-08")
        assertNotNull(t)
        val local = t!!.atZone(ZoneId.systemDefault()).toLocalDate()
        assertEquals(LocalDate.of(2026, 8, 8), local)
    }

    @Test
    fun `garbage returns null`() {
        assertNull(parseDueInstant("not-a-date"))
    }

    @Test
    fun `note dto accepts new offset format`() {
        val note = json.decodeFromString(
            Note.serializer(),
            """{"id":"n1","todo_due":"2026-08-08T15:30:00+08:00","category":"todo"}""",
        )
        assertEquals("2026-08-08T15:30:00+08:00", note.todoDue)
    }

    @Test
    fun `note dto accepts legacy offsetless format`() {
        val note = json.decodeFromString(
            Note.serializer(),
            """{"id":"n2","todo_due":"2026-08-08T15:30","category":"todo"}""",
        )
        assertEquals("2026-08-08T15:30", note.todoDue)
    }

    @Test
    fun `dueGroup handles both formats consistently`() {
        val today = LocalDate.of(2026, 8, 8)
        assertEquals(DueGroup.TODAY, dueGroup("2026-08-08T15:30:00+08:00", today))
        assertEquals(DueGroup.TODAY, dueGroup("2026-08-08T15:30", today))
        assertEquals(DueGroup.OVERDUE, dueGroup("2026-08-01", today))
        assertEquals(DueGroup.WEEK, dueGroup("2026-08-12", today))
        assertEquals(DueGroup.LATER, dueGroup("2026-09-01", today))
        assertEquals(DueGroup.NONE, dueGroup(null, today))
    }
}
