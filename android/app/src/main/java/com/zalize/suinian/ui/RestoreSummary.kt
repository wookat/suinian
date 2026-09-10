package com.zalize.suinian.ui

import com.zalize.suinian.data.RestoreStats

private const val MISSING_NAMES_SHOWN = 5

/** 备份恢复结果的一句话总结（与 web 设置页恢复文案同口径）：只在有值时展开各类跳过 / 缺失原因。 */
fun restoreSummary(stats: RestoreStats): String {
    val sb = StringBuilder()
    sb.append("恢复完成：笔记 ${stats.notesImported}/${stats.notesTotal} 条（跳过重复 ${stats.notesSkipped} 条）")
    if (stats.sensitiveSkipped > 0) {
        sb.append("，跳过脱敏占位的敏感笔记 ${stats.sensitiveSkipped} 条（迁移敏感内容请用勾选「包含敏感内容」的完整备份）")
    }
    sb.append("，媒体 ${stats.mediaImported} 个")
    if (stats.mediaOversized > 0) sb.append("，超过大小上限跳过 ${stats.mediaOversized} 个")
    if (stats.mediaFailed > 0) sb.append("，存档失败 ${stats.mediaFailed} 个")
    if (stats.mediaMissing > 0) sb.append("，备份包里缺少 ${stats.mediaMissing} 个")
    if (stats.reportsImported > 0 || stats.reportsSkipped > 0) {
        sb.append("，历史报告导入 ${stats.reportsImported} 份")
        if (stats.reportsSkipped > 0) sb.append("（跳过重复/无效 ${stats.reportsSkipped} 份）")
    }
    if (stats.threadsRebuilt > 0) sb.append("，${stats.threadsRebuilt} 条线索归组将由后台聚类重建")
    val missingTotal = stats.mediaOversized + stats.mediaFailed + stats.mediaMissing
    if (missingTotal > 0) {
        val names = stats.mediaMissingNotes.take(MISSING_NAMES_SHOWN).map { it.name }.filter { it.isNotBlank() }
        sb.append("。$missingTotal 个原件没跟上")
        if (names.isNotEmpty()) {
            sb.append("（${names.joinToString("、")}${if (missingTotal > names.size) " 等" else ""}）")
        }
        sb.append("：对应笔记已恢复并在卡片上标出「原件未随备份恢复」，需要原件的话请重新上传")
    }
    sb.append("。AI 分拣/线索/图谱会在后台陆续补全")
    return sb.toString()
}

/** 卡片提示：原件未随备份恢复的原因；非缺失态返回 null。 */
fun attachmentMissingText(reason: String?): String? {
    if (reason.isNullOrBlank()) return null
    val why = when (reason) {
        "oversized" -> "超过单文件大小上限"
        "failed" -> "存档失败"
        else -> "备份包里没有这个文件"
    }
    return "原件未随备份恢复（$why），需要原件请重新上传"
}
