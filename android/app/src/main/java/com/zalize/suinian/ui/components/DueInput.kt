package com.zalize.suinian.ui.components

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val DATE_RE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val DATE_TIME_RE = Regex("^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2})$")
private val INPUT_DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
private val OUTPUT_DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx")

const val DUE_INPUT_HINT = "请用 2026-08-10 或 2026-08-10 18:00"

/** 服务端 todo_due → 编辑框文本：含时刻按设备时区显示为 `yyyy-MM-dd HH:mm`，纯日期原样，解析不出原样 */
fun dueToInput(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String {
    if (iso.isNullOrBlank()) return ""
    val v = iso.trim()
    if (DATE_RE.matches(v)) return v
    val instant = parseDueInstant(v) ?: return v
    return instant.atZone(zone).format(INPUT_DATE_TIME)
}

sealed class DueInput {
    /** 留空：清除截止时间 */
    data object Empty : DueInput()

    /** 可发给服务端的值：纯日期原样；`yyyy-MM-dd HH:mm` 补上设备时区在该时刻的偏移；完整 ISO 原样 */
    data class Value(val due: String) : DueInput()

    data object Invalid : DueInput()
}

/** 编辑框文本 → 服务端 todo_due。裸时刻在客户端就带上设备偏移，不依赖服务端的 tz 偏好 */
fun inputToDue(text: String, zone: ZoneId = ZoneId.systemDefault()): DueInput {
    val s = text.trim()
    if (s.isEmpty()) return DueInput.Empty
    if (DATE_RE.matches(s)) {
        return runCatching { LocalDate.parse(s) }.fold({ DueInput.Value(s) }, { DueInput.Invalid })
    }
    val m = DATE_TIME_RE.matchEntire(s)
    if (m != null) {
        val local = runCatching { LocalDateTime.parse("${m.groupValues[1]}T${m.groupValues[2]}") }
            .getOrNull() ?: return DueInput.Invalid
        val offset = zone.rules.getOffset(local)
        return DueInput.Value(local.atOffset(offset).format(OUTPUT_DATE_TIME))
    }
    return runCatching { OffsetDateTime.parse(s.replace(' ', 'T')) }
        .fold({ DueInput.Value(s) }, { DueInput.Invalid })
}
