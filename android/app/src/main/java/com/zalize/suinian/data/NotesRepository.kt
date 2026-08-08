package com.zalize.suinian.data

import android.content.Context
import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.local.PendingNote
import com.zalize.suinian.data.local.PendingNoteDao
import com.zalize.suinian.sync.SyncWorker
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

sealed class SendResult {
    data class Sent(val note: Note?) : SendResult()
    /** 网络失败，已入本地队列稍后重试 */
    data object Queued : SendResult()
}

class NotesRepository(
    private val context: Context,
    private val settingsRepo: SettingsRepository,
    private val pendingDao: PendingNoteDao,
) {

    val pendingCount: Flow<Int> = pendingDao.count()

    private val json = Json { ignoreUnknownKeys = true }
    private val tagsSerializer = ListSerializer(String.serializer())

    private suspend fun api(): Pair<ApiClient, Boolean> {
        val s = settingsRepo.settings.first()
        return ApiClient(s.baseUrl, s.token) to s.mockMode
    }

    /** 发送 note；失败时入队并调度重试 */
    suspend fun send(req: CreateNoteRequest): SendResult {
        val (client, mock) = api()
        if (mock) return SendResult.Sent(MockStore.create(req))
        return try {
            SendResult.Sent(client.createNote(req))
        } catch (e: Exception) {
            pendingDao.insert(
                PendingNote(
                    source = req.source,
                    rawType = req.rawType,
                    content = req.content,
                    url = req.url,
                    tagsJson = req.tags?.let { json.encodeToString(tagsSerializer, it) },
                    skipTriage = req.skipTriage == true,
                )
            )
            SyncWorker.schedule(context)
            SendResult.Queued
        }
    }

    suspend fun list(category: String?, tag: String?, q: String?, cursor: String? = null): NotesPage {
        val (client, mock) = api()
        if (mock) return MockStore.list(category, tag, q)
        return client.listNotes(category = category, tag = tag, q = q, cursor = cursor)
    }

    suspend fun setTodoDone(id: String, done: Boolean): Note? {
        val (client, mock) = api()
        if (mock) return MockStore.setTodoDone(id, done)
        return client.setTodoDone(id, done)
    }

    /** 手动标记/取消敏感（PATCH is_sensitive） */
    suspend fun setSensitive(id: String, sensitive: Boolean): Note? {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.setSensitive(id, sensitive)
    }

    /** 编辑笔记：content/title/category/tags/todo_due（PATCH /api/notes/:id） */
    suspend fun updateNote(
        id: String,
        content: String? = null,
        title: String? = null,
        category: String? = null,
        tags: List<String>? = null,
        todoDue: String? = null,
        clearTodoDue: Boolean = false,
    ): Note? {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.updateNote(id, content, title, category, tags, todoDue, clearTodoDue)
    }

    /** 批量操作：delete / add_tags / remove_tags / set_category */
    suspend fun batchNotes(
        action: String,
        ids: List<String>,
        tags: List<String>? = null,
        category: String? = null,
    ): BatchResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.batchNotes(action, ids, tags, category)
    }

    /** 批量操作（全部匹配结果）：服务端按筛选条件执行，不限已加载项 */
    suspend fun batchNotesByFilter(
        action: String,
        filterCategory: String? = null,
        filterQuery: String? = null,
        tags: List<String>? = null,
        setCategory: String? = null,
    ): BatchResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.batchNotesByFilter(action, filterCategory, filterQuery, tags, setCategory)
    }

    /** 标签列表（含使用次数） */
    suspend fun listTags(): List<TagCount> {
        val (client, mock) = api()
        if (mock) return emptyList()
        return client.listTags()
    }

    /** 标签重命名/合并 */
    suspend fun renameTag(from: String, to: String) {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        client.renameTag(from, to)
    }

    /** 标签删除（不删笔记） */
    suspend fun deleteTag(tag: String) {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        client.deleteTag(tag)
    }

    /** 今日回顾（失败时静默隐藏，由调用方处理） */
    suspend fun getTodayReview(): DailyReviewResponse {
        val (client, mock) = api()
        if (mock) return DailyReviewResponse()
        return client.getTodayReview()
    }

    /** 手动生成周报/月报 */
    suspend fun generateReport(which: String = "this", period: String = "week"): Report {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.generateReport(which, period)
    }

    /** 永久注销账号并删除全部云端数据，成功后清本机登录状态 */
    suspend fun deleteAccount() {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        client.deleteAccount()
        settingsRepo.logout()
    }

    /** 链接笔记重试抓取 */
    suspend fun refetchLink(id: String): Note? {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.refetchLink(id)
    }

    /** 下载文件笔记原件：返回字节 + mime */
    suspend fun downloadNoteFile(id: String): Pair<ByteArray, String> {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.downloadNoteFile(id)
    }

    /** 下载全量备份 zip：返回字节 + 文件名。includeSensitive=true 时敏感笔记含明文 */
    suspend fun downloadBackup(includeSensitive: Boolean = false): Pair<ByteArray, String> {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.downloadBackup(includeSensitive)
    }

    /** 从备份 zip 恢复：返回恢复统计 */
    suspend fun restoreBackup(bytes: ByteArray, fileName: String): RestoreStats {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.restoreBackup(bytes, fileName)
    }

    suspend fun delete(id: String) {
        val (client, mock) = api()
        if (mock) {
            MockStore.delete(id)
            return
        }
        client.deleteNote(id)
    }

    suspend fun listThreads(): List<Thread> {
        val (client, mock) = api()
        if (mock) return emptyList()
        return client.listThreads().threads
    }

    suspend fun getThread(id: String): ThreadDetail {
        val (client, _) = api()
        return client.getThread(id)
    }

    suspend fun listReports(): List<ReportSummary> {
        val (client, mock) = api()
        if (mock) return emptyList()
        return client.listReports()
    }

    suspend fun getReport(id: String): Report {
        val (client, _) = api()
        return client.getReport(id)
    }

    suspend fun ask(question: String, history: List<AskHistoryMessage> = emptyList()): AskResponse {
        val (client, mock) = api()
        if (mock) return AskResponse(answer = "Mock 模式下问答不可用，请在设置中关闭 Mock 并连接真实后端。")
        return client.ask(question, history)
    }

    /** 图片上传：POST /api/ingest/media type=image（后端视觉识别成文字笔记） */
    suspend fun sendImage(bytes: ByteArray, mime: String, fileName: String): MediaIngestResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下图片上传不可用，请在设置中关闭 Mock")
        return client.ingestMedia("image", bytes, mime, fileName)
    }

    /** 文件上传：POST /api/ingest/media type=file（PDF/txt/md/docx，后端提取正文+存档原件） */
    suspend fun sendFile(bytes: ByteArray, mime: String, fileName: String): MediaIngestResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下文件上传不可用，请在设置中关闭 Mock")
        return client.ingestMedia("file", bytes, mime, fileName)
    }

    /** 轮换 API token，成功后自动保存新 token */
    suspend fun rotateToken(): String {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用")
        val newToken = client.rotateToken().apiToken
        if (newToken.isNotBlank()) settingsRepo.setToken(newToken)
        return newToken
    }

    /** 重试队列：全部成功返回 true */
    suspend fun flushPending(): Boolean {
        val (client, mock) = api()
        val pending = pendingDao.all()
        var allOk = true
        for (p in pending) {
            try {
                val tags = p.tagsJson?.let {
                    try {
                        json.decodeFromString(tagsSerializer, it)
                    } catch (_: Exception) {
                        null
                    }
                }
                val req = CreateNoteRequest(
                    source = p.source,
                    rawType = p.rawType,
                    content = p.content,
                    url = p.url,
                    tags = tags,
                    skipTriage = if (p.skipTriage) true else null,
                )
                if (mock) MockStore.create(req) else client.createNote(req)
                pendingDao.delete(p)
            } catch (e: Exception) {
                allOk = false
            }
        }
        return allOk
    }
}
