package com.zalize.suinian.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Note，字段形状与 docs/SPEC.md D1 notes 表一致 */
@Serializable
data class Note(
    val id: String,
    @SerialName("user_id") val userId: String? = null,
    val source: String = "android",          // wechat|android|web|api
    @SerialName("raw_type") val rawType: String = "text", // text|link|image|voice|file
    val content: String = "",
    val url: String? = null,
    @SerialName("url_title") val urlTitle: String? = null,
    @SerialName("url_summary") val urlSummary: String? = null,
    val category: String? = null,            // idea|todo|collect|data
    val tags: List<String> = emptyList(),
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("is_sensitive") val isSensitive: Int = 0,
    @SerialName("todo_due") val todoDue: String? = null,
    @SerialName("todo_done") val todoDone: Int? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** POST /api/notes 请求体：{source, raw_type, content, url?} */
@Serializable
data class CreateNoteRequest(
    val source: String,
    @SerialName("raw_type") val rawType: String,
    val content: String,
    val url: String? = null,
)

@Serializable
data class NotesPage(
    val notes: List<Note> = emptyList(),
    val cursor: String? = null,
)
