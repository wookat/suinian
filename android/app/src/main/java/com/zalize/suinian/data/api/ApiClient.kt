package com.zalize.suinian.data.api

import com.zalize.suinian.data.AskHistoryMessage
import com.zalize.suinian.data.AskResponse
import com.zalize.suinian.data.AuthResponse
import com.zalize.suinian.data.BatchResponse
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.DailyReviewResponse
import com.zalize.suinian.data.MediaIngestResponse
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NotesPage
import com.zalize.suinian.data.Report
import com.zalize.suinian.data.ReportDetail
import com.zalize.suinian.data.ReportsPage
import com.zalize.suinian.data.ReportSummary
import com.zalize.suinian.data.ThreadDetail
import com.zalize.suinian.data.PurgeResponse
import com.zalize.suinian.data.PushPreferences
import com.zalize.suinian.data.RandomNoteResponse
import com.zalize.suinian.data.RestoreResponse
import com.zalize.suinian.data.StatsResponse
import com.zalize.suinian.data.TrashResponse
import com.zalize.suinian.data.RestoreStats
import com.zalize.suinian.data.TodosTodayResponse
import com.zalize.suinian.data.RecoveryCodeResponse
import com.zalize.suinian.data.RotateTokenResponse
import com.zalize.suinian.data.TagCount
import com.zalize.suinian.data.TagsPage
import com.zalize.suinian.data.ThreadsPage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MultipartBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.buffer
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/** 备份 zip 最大 200MB（服务端 MAX_RESTORE_BYTES），按 ~0.5MB/s 慢网估算整包传输上限 */
internal const val BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS = 600L
/** 恢复 = 上传整包 + 服务端逐条导入并归档媒体，比下载多一段服务端处理时间 */
internal const val BACKUP_RESTORE_CALL_TIMEOUT_SECONDS = 900L
internal const val BACKUP_DOWNLOAD_TIMEOUT_MESSAGE =
    "备份下载超时：备份包较大或网络较慢，请在网络较好时重试"
internal const val BACKUP_RESTORE_TIMEOUT_MESSAGE =
    "恢复超时：备份包较大或网络较慢，服务端可能仍在导入，请稍后刷新列表确认；重新上传同一备份会自动跳过已导入的笔记"

/** 上传进度回调（已写入字节 / 请求体总字节），在 OkHttp 写线程回调 */
typealias UploadProgress = (sent: Long, total: Long) -> Unit

/** 包一层请求体，把写入 socket 的字节数报给 [onProgress]（每次 writeTo 从 0 重新计） */
private class ProgressRequestBody(
    private val delegate: RequestBody,
    private val onProgress: UploadProgress,
) : RequestBody() {
    override fun contentType(): MediaType? = delegate.contentType()
    override fun contentLength(): Long = delegate.contentLength()
    override fun writeTo(sink: BufferedSink) {
        val total = contentLength()
        var sent = 0L
        val counting = object : ForwardingSink(sink) {
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                sent += byteCount
                onProgress(sent, total)
            }
        }.buffer()
        delegate.writeTo(counting)
        counting.flush()
    }
}

/** 挂起等待响应；协程取消时 cancel() 整个 Call（阻塞式 execute() 不响应取消，上传会在 IO 线程继续跑完） */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
    cont.invokeOnCancellation { cancel() }
}

/** 面向用户的可读错误（网络/解析/HTTP 统一人话文案） */
class ApiException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** 乐观锁冲突（409）：笔记已被其他设备修改；latest 为服务器最新副本（409 响应体携带），供调用方展示对照合并 */
class ConflictException(message: String, val latest: Note? = null) : Exception(message)

/** 真实后端 client，接口形状严格按 docs/SPEC.md */
class ApiClient(private val baseUrl: String, private val token: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        // callTimeout 覆盖整次调用（含 DNS 解析）：connect/read 超时都不管 DNS，
        // 首启冷启动碰上 DNS 挂死会让首页骨架屏无限停留而非报错重试
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    // 备份下载 / 恢复上传是整包传输（≤200MB），总耗时随包体与网速线性增长：readTimeout 只管单次读的空闲，
    // callTimeout 才是整次调用的上限，newBuilder() 会继承基础 client 的 30s，必须一起放宽
    internal val backupDownloadClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(120, TimeUnit.SECONDS)
            .callTimeout(BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }
    internal val backupRestoreClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(300, TimeUnit.SECONDS)
            .writeTimeout(300, TimeUnit.SECONDS)
            .callTimeout(BACKUP_RESTORE_CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

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

    /** GET /api/notes?category=&tag=&q=&source=&from=&to=&cursor= */
    suspend fun listNotes(
        category: String? = null,
        tag: String? = null,
        q: String? = null,
        source: String? = null,
        from: String? = null,
        to: String? = null,
        cursor: String? = null,
    ): NotesPage = withContext(Dispatchers.IO) {
        val url = "$baseUrl/api/notes".toHttpUrl().newBuilder().apply {
            if (!category.isNullOrBlank()) addQueryParameter("category", category)
            if (!tag.isNullOrBlank()) addQueryParameter("tag", tag)
            if (!q.isNullOrBlank()) addQueryParameter("q", q)
            if (!source.isNullOrBlank()) addQueryParameter("source", source)
            if (!from.isNullOrBlank()) addQueryParameter("from", from)
            if (!to.isNullOrBlank()) addQueryParameter("to", to)
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
    suspend fun setTodoDone(id: String, done: Boolean): Note? =
        patchNote(id, buildJsonObject { put("todo_done", done) })

    /** PATCH /api/notes/:id：编辑 content/title/category/tags/todo_due（null 清除截止时间）。
     * baseUpdatedAt 传入编辑时加载的 updated_at，服务端乐观锁冲突时返 409 */
    suspend fun updateNote(
        id: String,
        content: String? = null,
        title: String? = null,
        category: String? = null,
        tags: List<String>? = null,
        todoDue: String? = null,
        clearTodoDue: Boolean = false,
        baseUpdatedAt: String? = null,
    ): Note? = patchNote(
        id,
        buildJsonObject {
            if (content != null) put("content", content)
            if (title != null) put("title", title)
            if (category != null) put("category", category)
            if (tags != null) putJsonArray("tags") { tags.forEach { add(JsonPrimitive(it)) } }
            if (todoDue != null) put("todo_due", todoDue)
            else if (clearTodoDue) put("todo_due", JsonNull)
            if (baseUpdatedAt != null) put("base_updated_at", baseUpdatedAt)
        },
    )

    /** POST /api/notes/batch：批量 delete / add_tags / remove_tags / set_category */
    suspend fun batchNotes(
        action: String,
        ids: List<String>,
        tags: List<String>? = null,
        category: String? = null,
    ): BatchResponse = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("action", action)
            putJsonArray("ids") { ids.forEach { add(JsonPrimitive(it)) } }
            if (tags != null) putJsonArray("tags") { tags.forEach { add(JsonPrimitive(it)) } }
            if (category != null) put("category", category)
        }.toString().toRequestBody(jsonMedia)
        execute(request("/api/notes/batch").post(body).build(), BatchResponse.serializer())
    }

    /** POST /api/notes/batch（filter 形态）：服务端按当前筛选条件对全部匹配笔记执行，不限已加载项 */
    suspend fun batchNotesByFilter(
        action: String,
        category: String? = null,
        q: String? = null,
        tag: String? = null,
        source: String? = null,
        from: String? = null,
        to: String? = null,
        tags: List<String>? = null,
        setCategory: String? = null,
    ): BatchResponse = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("action", action)
            put("filter", buildJsonObject {
                if (!category.isNullOrBlank()) put("category", category)
                if (!q.isNullOrBlank()) put("q", q)
                if (!tag.isNullOrBlank()) put("tag", tag)
                if (!source.isNullOrBlank()) put("source", source)
                if (!from.isNullOrBlank()) put("from", from)
                if (!to.isNullOrBlank()) put("to", to)
            })
            if (tags != null) putJsonArray("tags") { tags.forEach { add(JsonPrimitive(it)) } }
            if (setCategory != null) put("category", setCategory)
        }.toString().toRequestBody(jsonMedia)
        val client60 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        val resp = try {
            client60.newCall(request("/api/notes/batch").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) throw httpError(it.code, text)
            try {
                json.decodeFromString(BatchResponse.serializer(), text)
            } catch (e: Exception) {
                throw ApiException("服务器返回了无法识别的数据", e)
            }
        }
    }

    /** GET /api/tags：全部标签及使用次数 */
    suspend fun listTags(): List<TagCount> = withContext(Dispatchers.IO) {
        execute(request("/api/tags").get().build(), TagsPage.serializer()).tags
    }

    /** POST /api/tags/rename：全局重命名；改到已有标签即合并 */
    suspend fun renameTag(from: String, to: String): Unit = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("from", from)
            put("to", to)
        }.toString().toRequestBody(jsonMedia)
        val resp = try {
            client.newCall(request("/api/tags/rename").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use { if (!it.isSuccessful) throw httpError(it.code, it.body?.string()) }
    }

    /** POST /api/tags/delete：从所有笔记移除该标签（不删笔记） */
    suspend fun deleteTag(tag: String): Unit = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("tag", tag) }.toString().toRequestBody(jsonMedia)
        val resp = try {
            client.newCall(request("/api/tags/delete").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use { if (!it.isSuccessful) throw httpError(it.code, it.body?.string()) }
    }

    /** GET /api/review/today：今日回顾（那年今日/上月今日/久未回看） */
    suspend fun getTodayReview(): DailyReviewResponse = withContext(Dispatchers.IO) {
        execute(request("/api/review/today").get().build(), DailyReviewResponse.serializer())
    }

    /**
     * POST /api/reports/generate：手动生成周报/月报（which=this|last，period=week|month）。
     * 空数据窗口返回 report=null + 引导文案（message），不是错误。
     */
    suspend fun generateReport(which: String = "this", period: String = "week"): ReportDetail = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("week", which)
            put("which", which)
            put("period", period)
        }.toString().toRequestBody(jsonMedia)
        val client90 = client.newBuilder().readTimeout(90, TimeUnit.SECONDS).callTimeout(105, TimeUnit.SECONDS).build()
        val resp = try {
            client90.newCall(request("/api/reports/generate").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) throw httpError(it.code, text)
            try {
                json.decodeFromString(ReportDetail.serializer(), text)
            } catch (e: Exception) {
                throw ApiException("服务器返回了无法识别的数据", e)
            }
        }
    }

    /** DELETE /api/auth/me：永久注销账号并删除全部数据 */
    suspend fun deleteAccount(): Unit = withContext(Dispatchers.IO) {
        val client60 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        val resp = try {
            client60.newCall(request("/api/auth/me").delete().build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use { if (!it.isSuccessful) throw httpError(it.code, it.body?.string()) }
    }

    /** PATCH /api/notes/:id  {is_sensitive}（手动标记/取消敏感，后端同步加密/解密） */
    suspend fun setSensitive(id: String, sensitive: Boolean): Note? =
        patchNote(id, buildJsonObject { put("is_sensitive", sensitive) })

    private suspend fun patchNote(id: String, bodyObj: JsonObject): Note? = withContext(Dispatchers.IO) {
        val body = bodyObj.toString().toRequestBody(jsonMedia)
        val resp = try {
            client.newCall(request("/api/notes/$id").patch(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (it.code == 409) throw ConflictException(parseErrorMessage(text) ?: "这条笔记刚被更新（可能来自其他设备或后台自动整理），请刷新后重试", parseNoteLenient(text))
            if (!it.isSuccessful) throw httpError(it.code, text)
            parseNoteLenient(text)
        }
    }

    /** POST /api/notes/:id/refetch-link：链接笔记手动重试抓取标题/正文 */
    suspend fun refetchLink(id: String): Note? = withContext(Dispatchers.IO) {
        val body = "{}".toRequestBody(jsonMedia)
        val client60 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        val resp = try {
            client60.newCall(request("/api/notes/$id/refetch-link").post(body).build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code, it.body?.string())
            parseNoteLenient(it.body?.string().orEmpty())
        }
    }

    /** GET /api/notes/:id/file：下载原件字节（附件不超 10MB，直接读入内存） */
    suspend fun downloadNoteFile(id: String): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
        val client60 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        val resp = try {
            client60.newCall(request("/api/notes/$id/file").get().build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code, it.body?.string())
            val bytes = it.body?.bytes() ?: throw ApiException("下载失败：文件内容为空")
            val mime = it.header("Content-Type") ?: "application/octet-stream"
            bytes to mime
        }
    }

    /** GET /api/notes/:id/file?inline=1&att=：鉴权取附件原件字节（图片/语音内联展示用） */
    suspend fun fetchNoteMedia(id: String, attachmentId: String): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
        val url = "$baseUrl/api/notes/$id/file".toHttpUrl().newBuilder()
            .addQueryParameter("inline", "1")
            .addQueryParameter("att", attachmentId)
            .build()
        val client60 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").get().build()
        val resp = try {
            client60.newCall(req).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code, it.body?.string())
            val bytes = it.body?.bytes() ?: throw ApiException("加载失败：附件内容为空")
            val mime = it.header("Content-Type") ?: "application/octet-stream"
            bytes to mime
        }
    }

    /** POST /api/auth/recovery-code：重新生成恢复码（旧码作废，新码只显示一次） */
    suspend fun regenerateRecoveryCode(): String = withContext(Dispatchers.IO) {
        val body = "{}".toRequestBody(jsonMedia)
        execute(request("/api/auth/recovery-code").post(body).build(), RecoveryCodeResponse.serializer()).recoveryCode
    }

    /** POST /api/notes/restore：撤销软删（单次最多 1000 条，调用方已分批） */
    suspend fun restoreNotes(ids: List<String>): RestoreResponse = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            putJsonArray("ids") { ids.forEach { add(JsonPrimitive(it)) } }
        }.toString().toRequestBody(jsonMedia)
        execute(request("/api/notes/restore").post(body).build(), RestoreResponse.serializer())
    }

    /** GET /api/notes/trash：最近删除（软删且未彻底清理，含 purge_at） */
    suspend fun listTrash(): TrashResponse = withContext(Dispatchers.IO) {
        execute(request("/api/notes/trash").get().build(), TrashResponse.serializer())
    }

    /** POST /api/notes/purge：立即彻底删除已软删的笔记（不可恢复） */
    suspend fun purgeNotes(ids: List<String>): PurgeResponse = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            putJsonArray("ids") { ids.forEach { add(JsonPrimitive(it)) } }
        }.toString().toRequestBody(jsonMedia)
        execute(request("/api/notes/purge").post(body).build(), PurgeResponse.serializer())
    }

    /** POST /api/notes/trash/empty：清空回收站（不可恢复） */
    suspend fun emptyTrash(): PurgeResponse = withContext(Dispatchers.IO) {
        val body = "{}".toRequestBody(jsonMedia)
        execute(request("/api/notes/trash/empty").post(body).build(), PurgeResponse.serializer())
    }

    /** GET /api/stats：洞察页统计（days 默认 365，tz_offset 为东厕分钟数） */
    suspend fun getStats(days: Int = 365, tzOffsetMinutes: Int): StatsResponse = withContext(Dispatchers.IO) {
        execute(request("/api/stats?days=$days&tz_offset=$tzOffsetMinutes").get().build(), StatsResponse.serializer())
    }

    /** GET /api/notes/random：随机漫步一条历史笔记（无可抽时后端返 404） */
    suspend fun getRandomNote(): Note? = withContext(Dispatchers.IO) {
        val resp = try {
            client.newCall(request("/api/notes/random").get().build()).execute()
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = it.body?.string().orEmpty()
            if (it.code == 404) return@withContext null
            if (!it.isSuccessful) throw httpError(it.code, text)
            try {
                json.decodeFromString(RandomNoteResponse.serializer(), text).note
            } catch (e: Exception) {
                throw ApiException("服务器返回了无法识别的数据，请检查设置中的 API Base URL 是否正确", e)
            }
        }
    }

    /** GET /api/preferences：推送偏好 */
    suspend fun getPreferences(): PushPreferences = withContext(Dispatchers.IO) {
        execute(request("/api/preferences").get().build(), PushPreferences.serializer())
    }

    /** PATCH /api/preferences：更新推送偏好 / 用户时区（IANA id，服务端分拣、待办到期、今日待办、周月报边界都按它算） */
    suspend fun updatePreferences(
        dailyReviewPush: Boolean? = null,
        todoReminderPush: Boolean? = null,
        tz: String? = null,
    ): PushPreferences =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                if (dailyReviewPush != null) put("daily_review_push", dailyReviewPush)
                if (todoReminderPush != null) put("todo_reminder_push", todoReminderPush)
                if (tz != null) put("tz", tz)
            }.toString().toRequestBody(jsonMedia)
            execute(request("/api/preferences").patch(body).build(), PushPreferences.serializer())
        }

    /** GET /api/todos/today：当天到期 + 已过期的未完成待办 */
    suspend fun getTodosToday(): TodosTodayResponse = withContext(Dispatchers.IO) {
        execute(request("/api/todos/today").get().build(), TodosTodayResponse.serializer())
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
            ?: throw ApiException("报告不存在或已删除")
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
        val client30 = client.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(75, TimeUnit.SECONDS).build()
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

    /** GET /api/backup：全量备份 zip（笔记全字段 + 线索/周报 + 媒体原件），返回字节与文件名。敏感笔记默认脱敏，includeSensitive=true 时含明文 */
    suspend fun downloadBackup(includeSensitive: Boolean = false, password: String? = null): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
        val path = if (includeSensitive) "/api/backup?include_sensitive=true" else "/api/backup"
        val builder = request(path).get()
        // 敏感明文导出需密码复核；URLEncoder 编码以通过 HTTP 头 ASCII 限制（服务端解码）
        if (includeSensitive && !password.isNullOrEmpty()) {
            // URLEncoder 把空格编成 +，而服务端 decodeURIComponent 不还原 +，改用 %20
            builder.header("X-Suinian-Password", java.net.URLEncoder.encode(password, "UTF-8").replace("+", "%20"))
        }
        val resp = try {
            backupDownloadClient.newCall(builder.build()).execute()
        } catch (e: InterruptedIOException) {
            throw ApiException(BACKUP_DOWNLOAD_TIMEOUT_MESSAGE, e)
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            if (!it.isSuccessful) throw httpError(it.code, it.body?.string())
            val bytes = try {
                it.body?.bytes()
            } catch (e: InterruptedIOException) {
                throw ApiException(BACKUP_DOWNLOAD_TIMEOUT_MESSAGE, e)
            } catch (e: IOException) {
                throw ApiException("备份下载中断，请检查网络后重试", e)
            } ?: throw ApiException("备份下载失败：内容为空")
            val disposition = it.header("Content-Disposition").orEmpty()
            val fileName = Regex("filename=\"?([^\";]+)\"?").find(disposition)?.groupValues?.get(1)
                ?: "suinian-backup.zip"
            bytes to fileName
        }
    }

    /**
     * POST /api/backup/restore：上传备份 zip 恢复（multipart file），返回恢复统计。
     * [onProgress] 报上传进度；协程取消会中断上传（未传完的包服务端不会导入）
     */
    suspend fun restoreBackup(bytes: ByteArray, fileName: String, onProgress: UploadProgress? = null): RestoreStats = withContext(Dispatchers.IO) {
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody("application/zip".toMediaType()))
            .build()
        val body: RequestBody = if (onProgress != null) ProgressRequestBody(multipart, onProgress) else multipart
        val resp = try {
            backupRestoreClient.newCall(request("/api/backup/restore").post(body).build()).await()
        } catch (e: InterruptedIOException) {
            throw ApiException(BACKUP_RESTORE_TIMEOUT_MESSAGE, e)
        } catch (e: IOException) {
            throw ApiException("网络连接失败，请检查网络后重试", e)
        }
        resp.use {
            val text = try {
                it.body?.string().orEmpty()
            } catch (e: InterruptedIOException) {
                throw ApiException(BACKUP_RESTORE_TIMEOUT_MESSAGE, e)
            } catch (e: IOException) {
                throw ApiException("恢复结果读取中断：服务端可能已完成导入，请刷新列表确认；重新上传同一备份会自动跳过已导入的笔记", e)
            }
            if (!it.isSuccessful) throw httpError(it.code, text)
            try {
                json.decodeFromString(RestoreStats.serializer(), text)
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

        /** 公开接口：POST /api/auth/recover 用恢复码重置密码（成功后 token 轮换、下发新恢复码） */
        suspend fun recover(baseUrl: String, name: String, recoveryCode: String, newPassword: String): AuthResponse =
            withContext(Dispatchers.IO) {
                val body = buildJsonObject {
                    put("name", name)
                    put("recovery_code", recoveryCode)
                    put("new_password", newPassword)
                }.toString().toRequestBody(authMedia)
                val client = OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(20, TimeUnit.SECONDS)
                    .build()
                val req = Request.Builder().url("${baseUrl.trimEnd('/')}/api/auth/recover").post(body).build()
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
