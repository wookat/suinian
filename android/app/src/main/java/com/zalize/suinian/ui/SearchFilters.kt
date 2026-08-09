package com.zalize.suinian.ui

import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 来源筛选选项（与 Web timeline SOURCE_OPTIONS 对齐） */
val SOURCE_OPTIONS = listOf(
    "wechat" to "微信",
    "web" to "Web 速记",
    "android" to "Android",
    "extension" to "浏览器剪藏",
    "api" to "API",
    "import" to "导入",
    "from-ask" to "问答存档",
)

/** 时间范围预设：换算为 created_at 的 UTC 起点（开区间到现在） */
enum class TimeRange(val label: String, val days: Long) {
    TODAY("今天", 0),
    WEEK("近7天", 6),
    MONTH("近30天", 29),
}

private val SQL_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

/**
 * 本地日期零点转 UTC SQL 时间（与后端 created_at 存储格式对齐，
 * 对齐 Web timeline localDateToUtcSql）
 */
fun localDateStartToUtcSql(date: LocalDate, zone: ZoneId = ZoneId.systemDefault()): String =
    date.atStartOfDay(zone).toInstant().atZone(ZoneId.of("UTC")).format(SQL_FORMAT)

fun TimeRange.fromParam(today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): String =
    localDateStartToUtcSql(today.minusDays(days), zone)
