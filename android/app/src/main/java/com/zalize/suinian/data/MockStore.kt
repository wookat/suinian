package com.zalize.suinian.data

import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID

/** Mock 数据源：后端未就绪时本地模拟 /api/notes 行为（内存态） */
object MockStore {

    private val notes = mutableListOf(
        sample("周末把碎念的分享接收流程再打磨一下，确认页要够轻", "idea", listOf("产品", "碎念"), hoursAgo = 2),
        sample("买菜：西红柿、鸡蛋、面条", "todo", listOf("生活"), hoursAgo = 5),
        sample(
            "Compose Glance 小组件官方指南", "collect", listOf("Android", "开发"),
            url = "https://developer.android.com/develop/ui/compose/glance",
            urlTitle = "Build a widget with Glance",
            urlSummary = "使用 Jetpack Glance 以 Compose 语法构建 App Widget 的官方文档。",
            hoursAgo = 26,
        ),
        sample("Wi-Fi 访客密码 guest-2026", "data", listOf("密码"), hoursAgo = 50),
        sample("flomo 的轻盈感来自：无文件夹、输入框常驻、标签即结构", "idea", listOf("竞品", "设计"), hoursAgo = 74),
    )

    private fun sample(
        content: String,
        category: String,
        tags: List<String>,
        url: String? = null,
        urlTitle: String? = null,
        urlSummary: String? = null,
        hoursAgo: Long = 0,
    ) = Note(
        id = UUID.randomUUID().toString(),
        source = "android",
        rawType = if (url != null) "link" else "text",
        content = content,
        url = url,
        urlTitle = urlTitle,
        urlSummary = urlSummary,
        category = category,
        tags = tags,
        createdAt = Instant.now().minus(hoursAgo, ChronoUnit.HOURS).toString(),
    )

    @Synchronized
    fun create(req: CreateNoteRequest): Note {
        val isLink = req.rawType == "link" || req.url != null
        val note = Note(
            id = UUID.randomUUID().toString(),
            source = req.source,
            rawType = req.rawType,
            content = req.content,
            url = req.url,
            category = when {
                req.rawType == "image" -> "collect"
                isLink -> "collect"
                else -> "idea"
            },
            tags = listOf("待分拣"),
            createdAt = Instant.now().toString(),
        )
        notes.add(0, note)
        return note
    }

    @Synchronized
    fun getNote(id: String): Note? = notes.firstOrNull { it.id == id }

    @Synchronized
    fun setTodoDone(id: String, done: Boolean): Note? {
        val idx = notes.indexOfFirst { it.id == id }
        if (idx < 0) return null
        val updated = notes[idx].copy(todoDone = done)
        notes[idx] = updated
        return updated
    }

    @Synchronized
    fun delete(id: String): Boolean = notes.removeAll { it.id == id }

    @Synchronized
    fun list(category: String?, tag: String?, q: String?): NotesPage {
        var result = notes.toList()
        if (!category.isNullOrBlank()) result = result.filter { it.category == category }
        if (!tag.isNullOrBlank()) result = result.filter { tag in it.tags }
        if (!q.isNullOrBlank()) {
            val query = q.trim()
            result = result.filter {
                it.content.contains(query, ignoreCase = true) ||
                    it.urlTitle?.contains(query, ignoreCase = true) == true ||
                    it.tags.any { t -> t.contains(query, ignoreCase = true) }
            }
        }
        return NotesPage(notes = result)
    }
}
