package com.zalize.suinian.data

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/** 前后端一致的输入限制（对齐 backend MAX_CONTENT_CHARS） */
object NotesViewLimits {
    const val MAX_CONTENT_CHARS = 20_000
}

/** 布尔字段容错序列化器：同时接受 JSON true/false 与 0/1（历史 D1 整型形态） */
object FlexibleBooleanSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("FlexibleBoolean", PrimitiveKind.BOOLEAN)

    override fun deserialize(decoder: Decoder): Boolean {
        if (decoder is JsonDecoder) {
            val primitive = decoder.decodeJsonElement().jsonPrimitive
            primitive.booleanOrNull?.let { return it }
            primitive.intOrNull?.let { return it != 0 }
            return false
        }
        return decoder.decodeBoolean()
    }

    override fun serialize(encoder: Encoder, value: Boolean) = encoder.encodeBoolean(value)
}

/** notes.meta JSON：语音原稿 / 图片描述 / 链接站点与正文摘录 */
@Serializable
data class NoteMeta(
    @SerialName("raw_transcript") val rawTranscript: String? = null,
    @SerialName("image_description") val imageDescription: String? = null,
    @SerialName("link_site") val linkSite: String? = null,
    @SerialName("link_excerpt") val linkExcerpt: String? = null,
)

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
    @SerialName("url_titles") val urlTitles: List<UrlTitle>? = null,
    val title: String? = null,
    val category: String? = null,            // idea|todo|collect|data
    val tags: List<String> = emptyList(),
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("is_sensitive")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val isSensitive: Boolean = false,
    @SerialName("todo_due") val todoDue: String? = null,
    @SerialName("todo_done")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val todoDone: Boolean? = null,
    val meta: NoteMeta? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** 多链接卡：url_titles 数组元素 */
@Serializable
data class UrlTitle(
    val url: String,
    val title: String? = null,
)

/** POST /api/notes 请求体：{source, raw_type, content, url?} */
@Serializable
data class CreateNoteRequest(
    val source: String,
    @SerialName("raw_type") val rawType: String,
    val content: String,
    val url: String? = null,
)

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class NotesPage(
    val notes: List<Note> = emptyList(),
    @kotlinx.serialization.json.JsonNames("next_cursor") val cursor: String? = null,
)

/** GET /api/threads 元素 */
@Serializable
data class Thread(
    val id: String,
    val title: String = "",
    val summary: String? = null,
    @SerialName("note_count") val noteCount: Int = 0,
    @SerialName("updated_at") val updatedAt: String = "",
)

@Serializable
data class ThreadsPage(val threads: List<Thread> = emptyList())

/** GET /api/threads/:id */
@Serializable
data class ThreadDetail(
    val thread: Thread,
    val notes: List<Note> = emptyList(),
)

/** GET /api/reports 元素（列表只有摘要字段） */
@Serializable
data class ReportSummary(
    val id: String,
    @SerialName("week_start") val weekStart: String = "",
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class ReportsPage(val reports: List<ReportSummary> = emptyList())

/** GET /api/reports/:id */
@Serializable
data class Report(
    val id: String,
    @SerialName("week_start") val weekStart: String = "",
    @SerialName("content_md") val contentMd: String = "",
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class ReportDetail(val report: Report)

/** POST /api/ask 响应：references 元素为 {index, note_id} */
@Serializable
data class AskReference(
    val index: Int = 0,
    @SerialName("note_id") val noteId: String = "",
)

@Serializable
data class AskResponse(
    val answer: String = "",
    val references: List<AskReference> = emptyList(),
    val notes: List<Note> = emptyList(),
)

/** /api/ask 多轮对话 history 元素 */
@Serializable
data class AskHistoryMessage(
    val role: String, // user|assistant
    val content: String,
)

/** /api/auth/register 与 /api/auth/login 响应 */
@Serializable
data class AuthUser(
    val id: String,
    val name: String = "",
)

@Serializable
data class AuthResponse(
    val user: AuthUser,
    @SerialName("api_token") val apiToken: String = "",
)

/** POST /api/auth/rotate-token 响应 */
@Serializable
data class RotateTokenResponse(
    @SerialName("api_token") val apiToken: String = "",
)

/** POST /api/ingest/media 响应（只取 note 与 text） */
@Serializable
data class MediaIngestResponse(
    val note: Note? = null,
    val text: String? = null,
    val transcribed: Boolean = false,
)
