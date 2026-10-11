package com.zalize.suinian.reminder

import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.parseDueInstant
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** 每日回顾推送不早于本地上午 8 点，避免半夜打扰 */
const val REVIEW_NOTIFY_HOUR = 8

/** 纯日期待办（YYYY-MM-DD）视为当天本地 09:00 到期，与服务端 todoDueInstantMs / 提醒口径一致 */
val DATE_ONLY_DUE_TIME: LocalTime = LocalTime.of(9, 0)

private val DATE_ONLY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

/** 本地已提醒记录的去重 key：截止时间变了会重新提醒 */
fun todoReminderKey(note: Note): String = "todo:${note.id}:${note.todoDue.orEmpty()}"

fun reviewReminderKey(date: String): String = "review:$date"

/** 待办提醒时刻：纯日期为当天本地 09:00，带时刻按其瞬间（无偏移历史值按 +08:00） */
fun todoDueInstant(due: String, zone: ZoneId = ZoneId.systemDefault()): Instant? {
    val v = due.trim()
    if (DATE_ONLY.matches(v)) {
        return runCatching { LocalDate.parse(v).atTime(DATE_ONLY_DUE_TIME).atZone(zone).toInstant() }.getOrNull()
    }
    return parseDueInstant(v)
}

/** 到点未完成的待办：todo_due 已到（含过期）且未标记完成 */
fun dueTodos(notes: List<Note>, now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<Note> = notes.filter { n ->
    n.todoDone != true && !n.todoDue.isNullOrBlank() &&
        (todoDueInstant(n.todoDue, zone)?.let { !it.isAfter(now) } ?: false)
}
