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
    @SerialName("is_sensitive")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val isSensitive: Boolean = false,
    @SerialName("todo_due") val todoDue: String? = null,
    @SerialName("todo_done")
    @Serializable(with = FlexibleBooleanSerializer::class)
    val todoDone: Boolean? = null,
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

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
data class NotesPage(
    val notes: List<Note> = emptyList(),
    @kotlinx.serialization.json.JsonNames("next_cursor") val cursor: String? = null,
)
