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

/** notes.meta JSON：语音原稿 / 图片描述 / 链接站点与正文摘录 / 文件原件信息 */
@Serializable
data class NoteMeta(
    @SerialName("raw_transcript") val rawTranscript: String? = null,
    @SerialName("image_description") val imageDescription: String? = null,
    @SerialName("link_site") val linkSite: String? = null,
    @SerialName("link_excerpt") val linkExcerpt: String? = null,
    @SerialName("link_status") val linkStatus: String? = null, // ok|no_content|fetch_failed
    @SerialName("file_name") val fileName: String? = null,
    @SerialName("file_mime") val fileMime: String? = null,
    @SerialName("file_size") val fileSize: Long? = null,
    @SerialName("file_kind") val fileKind: String? = null, // pdf|txt|md|docx
    @SerialName("file_excerpt") val fileExcerpt: String? = null,
    @SerialName("file_status") val fileStatus: String? = null, // ok|extract_failed
    @SerialName("finance_merchant") val financeMerchant: String? = null,
    /** 备份恢复时原件没跟上：oversized|failed|missing（服务端无 attachment 行，/file 必 404） */
    @SerialName("attachment_missing") val attachmentMissing: String? = null,
)

/** 附件元信息（不含 R2 key）；原件通过 GET /api/notes/:id/file?att= 鉴权获取 */
@Serializable
data class NoteAttachment(
    val id: String,
    val name: String = "",
    val mime: String? = null,
    val size: Long? = null,
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
    val category: String? = null,            // idea|todo|collect|data|expense|income
    val tags: List<String> = emptyList(),
    val amount: Double? = null,
    val currency: String? = null,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("is_sensitive")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val isSensitive: Boolean = false,
    @SerialName("todo_due") val todoDue: String? = null,
    @SerialName("todo_done")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val todoDone: Boolean? = null,
    val meta: NoteMeta? = null,
    val attachments: List<NoteAttachment>? = null,
    /** 搜索召回方式（与 Web 一致）：keyword|semantic|both */
    val match: String? = null,
    @SerialName("deleted_at") val deletedAt: String? = null,
    /** 最近删除列表项：预计彻底清理时间（UTC） */
    @SerialName("purge_at") val purgeAt: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String? = null,
)

/** 多链接卡：url_titles 数组元素 */
@Serializable
data class UrlTitle(
    val url: String,
    val title: String? = null,
)

/** POST /api/notes 请求体：{source, raw_type, content, url?, tags?, skip_triage?} */
@Serializable
data class CreateNoteRequest(
    val source: String,
    @SerialName("raw_type") val rawType: String,
    val content: String,
    val url: String? = null,
    val tags: List<String>? = null,
    @SerialName("skip_triage") val skipTriage: Boolean? = null,
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
    val graph: ThreadGraph? = null,
)

/** 线索实体脉络：GET /api/threads/:id 返回的 graph 字段 */
@Serializable
data class ThreadGraph(
    val entities: List<GraphEntity> = emptyList(),
    val relations: List<GraphRelation> = emptyList(),
)

@Serializable
data class GraphEntity(
    val id: String,
    val name: String = "",
    val type: String = "other", // person|project|concept|product|org|place|other
    @SerialName("note_count") val noteCount: Int = 0,
)

@Serializable
data class GraphRelation(
    val src: String = "",
    val dst: String = "",
    @SerialName("relation_label") val relationLabel: String = "",
)

/** GET /api/reports 元素（列表只有摘要字段） */
@Serializable
data class ReportSummary(
    val id: String,
    @SerialName("week_start") val weekStart: String = "",
    val period: String = "week", // week|month
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class ReportsPage(val reports: List<ReportSummary> = emptyList())

/** GET /api/reports/:id */
@Serializable
data class Report(
    val id: String,
    @SerialName("week_start") val weekStart: String = "",
    val period: String = "week", // week|month
    @SerialName("content_md") val contentMd: String = "",
    @SerialName("created_at") val createdAt: String = "",
)

@Serializable
data class ReportDetail(val report: Report? = null, val message: String? = null)

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
    /** 注册/恢复成功时一次性下发的恢复码（仅此一次，服务端不存明文） */
    @SerialName("recovery_code") val recoveryCode: String? = null,
)

/** POST /api/auth/recovery-code 响应 */
@Serializable
data class RecoveryCodeResponse(
    @SerialName("recovery_code") val recoveryCode: String = "",
)

/** POST /api/auth/rotate-token 响应 */
@Serializable
data class RotateTokenResponse(
    @SerialName("api_token") val apiToken: String = "",
)

/** GET /api/review/today：那年今日 / 上月今日 / 久未回看 */
@Serializable
data class DailyReviewItem(
    val id: String,
    val kind: String = "",
    @SerialName("kind_label") val kindLabel: String = "",
    val comment: String? = null,
    val note: Note,
)

@Serializable
data class DailyReviewResponse(
    val date: String = "",
    val items: List<DailyReviewItem> = emptyList(),
)

/** GET /api/tags 元素：标签及使用次数 */
@Serializable
data class TagCount(
    val tag: String,
    val count: Int = 0,
)

@Serializable
data class TagsPage(val tags: List<TagCount> = emptyList())

/** POST /api/notes/batch 响应（delete 时回传 ids 供撤销，remaining 为超出单批上限的剩余匹配数） */
@Serializable
data class BatchResponse(
    val ok: Boolean = false,
    val affected: Int = 0,
    val remaining: Int = 0,
    val ids: List<String> = emptyList(),
)

/** POST /api/notes/restore 响应 */
@Serializable
data class RestoreResponse(
    val ok: Boolean = false,
    val restored: Int = 0,
)

/** GET /api/preferences：推送偏好（每日回顾 / 待办提醒），与 Web Push 共用 */
@Serializable
data class PushPreferences(
    @SerialName("daily_review_push") val dailyReviewPush: Boolean = true,
    @SerialName("todo_reminder_push") val todoReminderPush: Boolean = true,
)

/** GET /api/todos/today：当天到期 + 已过期的未完成待办 */
@Serializable
data class TodosTodayResponse(
    val date: String = "",
    val items: List<Note> = emptyList(),
)

/** POST /api/backup/restore 响应：恢复统计（字段与 backend RestoreStats 一致） */
@Serializable
data class RestoreStats(
    @SerialName("notes_total") val notesTotal: Int = 0,
    @SerialName("notes_imported") val notesImported: Int = 0,
    @SerialName("notes_skipped") val notesSkipped: Int = 0,
    /** 脱敏备份里的「[已加密内容]」占位壳：无明文可恢复，跳过不导入 */
    @SerialName("sensitive_skipped") val sensitiveSkipped: Int = 0,
    @SerialName("reports_imported") val reportsImported: Int = 0,
    @SerialName("reports_skipped") val reportsSkipped: Int = 0,
    @SerialName("threads_rebuilt") val threadsRebuilt: Int = 0,
    @SerialName("media_imported") val mediaImported: Int = 0,
    @SerialName("media_skipped") val mediaSkipped: Int = 0,
    @SerialName("media_oversized") val mediaOversized: Int = 0,
    @SerialName("media_failed") val mediaFailed: Int = 0,
    @SerialName("media_missing") val mediaMissing: Int = 0,
    @SerialName("media_missing_notes") val mediaMissingNotes: List<RestoreMissingMedia> = emptyList(),
)

/** 原件未随笔记恢复的附件：笔记已入库并打上 meta.attachment_missing */
@Serializable
data class RestoreMissingMedia(
    @SerialName("note_id") val noteId: String,
    val name: String = "",
    val reason: String = "missing", // oversized|failed|missing
)

/** GET /api/notes/trash：最近删除（软删且未彻底清理） */
@Serializable
data class TrashResponse(
    val notes: List<Note> = emptyList(),
    @SerialName("retention_days") val retentionDays: Int = 30,
)

/** POST /api/notes/purge 与 /api/notes/trash/empty 响应 */
@Serializable
data class PurgeResponse(
    val ok: Boolean = false,
    val purged: Int = 0,
)

/** GET /api/stats：洞察页统计（与 Web 共用后端口径） */
@Serializable
data class StatsDaily(
    val date: String = "",
    val count: Int = 0,
)

@Serializable
data class StatsStreak(
    val current: Int = 0,
    val longest: Int = 0,
)

@Serializable
data class StatsCategoryCount(
    val category: String = "",
    val count: Int = 0,
)

@Serializable
data class StatsSourceCount(
    val source: String = "",
    val count: Int = 0,
)

@Serializable
data class StatsResponse(
    @SerialName("total_notes") val totalNotes: Int = 0,
    @SerialName("thread_count") val threadCount: Int = 0,
    val daily: List<StatsDaily> = emptyList(),
    val streak: StatsStreak = StatsStreak(),
    val categories: List<StatsCategoryCount> = emptyList(),
    val sources: List<StatsSourceCount> = emptyList(),
    @SerialName("top_tags") val topTags: List<TagCount> = emptyList(),
)

/** GET /api/notes/random 响应：随机漫步一条历史笔记 */
@Serializable
data class RandomNoteResponse(
    val note: Note? = null,
)

/** POST /api/ingest/media 响应（只取 note 与 text） */
@Serializable
data class MediaIngestResponse(
    val note: Note? = null,
    val text: String? = null,
    val transcribed: Boolean = false,
)
