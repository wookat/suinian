package com.zalize.suinian.data.api

import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NotesPage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 真实后端 client，接口形状严格按 docs/SPEC.md */
class ApiClient(private val baseUrl: String, private val token: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    /** POST /api/notes */
    suspend fun createNote(req: CreateNoteRequest): Note? = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CreateNoteRequest.serializer(), req).toRequestBody(jsonMedia)
        val request = Request.Builder()
            .url("$baseUrl/api/notes")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("POST /api/notes HTTP ${resp.code}")
            val text = resp.body?.string().orEmpty()
            parseNoteLenient(text)
        }
    }

    /** GET /api/notes?category=&tag=&q=&cursor= */
    suspend fun listNotes(
        category: String? = null,
        tag: String? = null,
        q: String? = null,
        cursor: String? = null,
    ): NotesPage = withContext(Dispatchers.IO) {
        val url = "$baseUrl/api/notes".toHttpUrl().newBuilder().apply {
            if (!category.isNullOrBlank()) addQueryParameter("category", category)
            if (!tag.isNullOrBlank()) addQueryParameter("tag", tag)
            if (!q.isNullOrBlank()) addQueryParameter("q", q)
            if (!cursor.isNullOrBlank()) addQueryParameter("cursor", cursor)
        }.build()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("GET /api/notes HTTP ${resp.code}")
            val text = resp.body?.string().orEmpty()
            json.decodeFromString(NotesPage.serializer(), text)
        }
    }

    /** 后端可能返回 note 对象本身，或 {note: {...}}；两种都兼容 */
    private fun parseNoteLenient(text: String): Note? = try {
        val element = json.parseToJsonElement(text)
        val obj: JsonObject = element.jsonObject
        val noteObj = obj["note"]?.jsonObject ?: obj
        if (noteObj.containsKey("id")) json.decodeFromJsonElement(Note.serializer(), noteObj) else null
    } catch (_: Exception) {
        null
    }
}
