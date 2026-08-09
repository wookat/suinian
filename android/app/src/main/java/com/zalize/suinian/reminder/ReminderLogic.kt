package com.zalize.suinian.reminder

import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.parseDueInstant
import java.time.Instant

/** 每日回顾推送不早于本地上午 8 点，避免半夜打扰 */
const val REVIEW_NOTIFY_HOUR = 8

/** 本地已提醒记录的去重 key：截止时间变了会重新提醒 */
fun todoReminderKey(note: Note): String = "todo:${note.id}:${note.todoDue.orEmpty()}"

fun reviewReminderKey(date: String): String = "review:$date"

/** 到点未完成的待办：todo_due 已到（含过期）且未标记完成 */
fun dueTodos(notes: List<Note>, now: Instant): List<Note> = notes.filter { n ->
    n.todoDone != true && !n.todoDue.isNullOrBlank() &&
        (parseDueInstant(n.todoDue)?.let { !it.isAfter(now) } ?: false)
}
