package com.zalize.suinian.data.api

import com.zalize.suinian.data.AskHistoryMessage
import com.zalize.suinian.data.AskResponse
import com.zalize.suinian.data.AuthResponse
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.MediaIngestResponse
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NotesPage
import com.zalize.suinian.data.Report
import com.zalize.suinian.data.ReportDetail
import com.zalize.suinian.data.ReportsPage
import com.zalize.suinian.data.ReportSummary
import com.zalize.suinian.data.ThreadDetail
import com.zalize.suinian.data.RotateTokenResponse
import com.zalize.suinian.data.ThreadsPage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import okhttp3.MultipartBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 面向用户的可读错误（网络/解析/HTTP 统一人话文案） */
class ApiException(message: String, cause: Throwable? = null) : Exception(message, cause)

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

    private fun httpError(code: Int, body: String? = null): ApiException {
        val serverMsg = body?.let { parseErrorMessage(it) }
        if (serverMsg != null) return ApiException(serverMsg)
        return defaultHttpError(code)
    }

    private fun parseErrorMessage(body: String): String? = try {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() && it != "unauthorized" }
    } catch (_: Exception) {
        null
    }

    private fun defaultHttpError(code: Int): ApiException = when (code) {
        401, 403 -> ApiException("Token 无效或没有权限，请在设置中检查 API Token")
        404 -> ApiException("内容不存在或已被删除")
        413 -> ApiException("内容过长：最多 20000 字符，请拆成多条或精简后再发")
        in 500..599 -> ApiException("服务器开小差了（$code），请稍后重试")
        else -> ApiException("请求失败（$code），请稍后重试")
    }

    private fun <T> execute(request: Request, deserializer: DeserializationStrategy<T>): T {
        val resp = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) throw httpError(it.code, text)
            return try {
                json.decodeFromString(deserializer, text)
            } catch (e: Exception) {
                throw ApiException("服务器返回了无法识别的数据，请检查设置中的 API Base URL 是否正确", e)
            }
        }
    }

    private fun request(path: String): Request.Builder = Request.Builder()
        .url("$baseUrl$path")
        .header("Authorization", "Bearer $token")

    /** POST /api/notes */
    suspend fun createNote(req: CreateNoteRequest): Note? = withContext(Dispatchers.IO) {
        val body = json.encodeToString(CreateNoteRequest.serializer(), req).toRequestBody(jsonMedia)
        val resp = try {
            client.newCall(request("/api/notes").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code)
            parseNoteLenient(it.body?.string().orEmpty())
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
        val req = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        execute(req, NotesPage.serializer())
    }

    /** PATCH /api/notes/:id  {todo_done} */
    suspend fun setTodoDone(id: String, done: Boolean): Note? = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("todo_done", done) }.toString().toRequestBody(jsonMedia)
        val resp = try {
            client.newCall(request("/api/notes/$id").patch(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code)
            parseNoteLenient(it.body?.string().orEmpty())
        }
    }

    /** DELETE /api/notes/:id */
    suspend fun deleteNote(id: String): Unit = withContext(Dispatchers.IO) {
        val resp = try {
            client.newCall(request("/api/notes/$id").delete().build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use { if (!it.isSuccessful) throw httpError(it.code) }
    }

    /** GET /api/threads */
    suspend fun listThreads(): ThreadsPage = withContext(Dispatchers.IO) {
        execute(request("/api/threads").get().build(), ThreadsPage.serializer())
    }

    /** GET /api/threads/:id */
    suspend fun getThread(id: String): ThreadDetail = withContext(Dispatchers.IO) {
        execute(request("/api/threads/$id").get().build(), ThreadDetail.serializer())
    }

    /** GET /api/reports */
    suspend fun listReports(): List<ReportSummary> = withContext(Dispatchers.IO) {
        execute(request("/api/reports").get().build(), ReportsPage.serializer()).reports
    }

    /** GET /api/reports/:id */
    suspend fun getReport(id: String): Report = withContext(Dispatchers.IO) {
        execute(request("/api/reports/$id").get().build(), ReportDetail.serializer()).report
    }

    /** POST /api/ask  {question, history?} 多轮对话 */
    suspend fun ask(question: String, history: List<AskHistoryMessage> = emptyList()): AskResponse = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("question", question)
            if (history.isNotEmpty()) {
                putJsonArray("history") {
                    history.forEach { m ->
                        addJsonObject {
                            put("role", m.role)
                            put("content", m.content)
                        }
                    }
                }
            }
        }.toString().toRequestBody(jsonMedia)
        execute(request("/api/ask").post(body).build(), AskResponse.serializer())
    }

    /** POST /api/ingest/media（multipart：type=image|audio + file） */
    suspend fun ingestMedia(
        type: String,
        bytes: ByteArray,
        mime: String,
        fileName: String,
    ): MediaIngestResponse = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("type", type)
            .addFormDataPart("source", "android")
            .addFormDataPart("file", fileName, bytes.toRequestBody(mime.toMediaType()))
            .build()
        val req = request("/api/ingest/media").post(body).build()
        val client30 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()
        val resp = try {
            client30.newCall(req).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) throw httpError(it.code, text)
            try {
                json.decodeFromString(MediaIngestResponse.serializer(), text)
            } catch (e: Exception) {
                throw ApiException("服务器返回了无法识别的数据", e)
            }
        }
    }

    /** POST /api/auth/rotate-token */
    suspend fun rotateToken(): RotateTokenResponse = withContext(Dispatchers.IO) {
        val body = "{}".toRequestBody(jsonMedia)
        execute(request("/api/auth/rotate-token").post(body).build(), RotateTokenResponse.serializer())
    }

    companion object {
        private val authJson = Json { ignoreUnknownKeys = true; coerceInputValues = true }
        private val authMedia = "application/json; charset=utf-8".toMediaType()

        /** 公开接口（无需 token）：POST /api/auth/register | /api/auth/login */
        private suspend fun authCall(baseUrl: String, path: String, name: String, password: String): AuthResponse =
            withContext(Dispatchers.IO) {
                val body = buildJsonObject {
                    put("name", name)
                    put("password", password)
                }.toString().toRequestBody(authMedia)
                val client = OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(20, TimeUnit.SECONDS)
                    .build()
                val req = Request.Builder().url("${baseUrl.trimEnd('/')}$path").post(body).build()
                val resp = try {
                    client.newCall(req).execute()
                } catch (e: IOException) {
                    throw ApiException("网络连接失败，请检查网络后重试", e)
                }
                resp.use {
                    val text = it.body?.string().orEmpty()
                    if (!it.isSuccessful) {
                        val msg = try {
                            authJson.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.content
                        } catch (_: Exception) {
                            null
                        }
                        throw ApiException(msg ?: "请求失败（${it.code}），请稍后重试")
                    }
                    try {
                        authJson.decodeFromString(AuthResponse.serializer(), text)
                    } catch (e: Exception) {
                        throw ApiException("服务器返回了无法识别的数据，请检查 API Base URL 是否正确", e)
                    }
                }
            }

        suspend fun register(baseUrl: String, name: String, password: String): AuthResponse =
            authCall(baseUrl, "/api/auth/register", name, password)

        suspend fun login(baseUrl: String, name: String, password: String): AuthResponse =
            authCall(baseUrl, "/api/auth/login", name, password)
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
