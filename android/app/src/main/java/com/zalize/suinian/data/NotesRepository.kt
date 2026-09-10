package com.zalize.suinian.data

import android.content.Context
import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.DownloadProgress
import com.zalize.suinian.data.api.UploadProgress
import java.io.OutputStream
import com.zalize.suinian.data.local.PendingNote
import com.zalize.suinian.data.local.PendingNoteDao
import com.zalize.suinian.sync.SyncWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.TimeZone
import java.io.File
import java.io.IOException

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
    private val mediaCache = MediaCache(java.io.File(context.cacheDir, "media"))

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

    suspend fun list(
        category: String?,
        tag: String?,
        q: String?,
        source: String? = null,
        from: String? = null,
        to: String? = null,
        cursor: String? = null,
    ): NotesPage {
        val (client, mock) = api()
        if (mock) return MockStore.list(category, tag, q)
        return client.listNotes(category = category, tag = tag, q = q, source = source, from = from, to = to, cursor = cursor)
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
        baseUpdatedAt: String? = null,
    ): Note? {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.updateNote(id, content, title, category, tags, todoDue, clearTodoDue, baseUpdatedAt)
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
        filterTag: String? = null,
        filterSource: String? = null,
        filterFrom: String? = null,
        filterTo: String? = null,
        tags: List<String>? = null,
        setCategory: String? = null,
    ): BatchResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.batchNotesByFilter(
            action, filterCategory, filterQuery, filterTag, filterSource, filterFrom, filterTo, tags, setCategory,
        )
    }

    /** 撤销软删：恢复未过期的已删笔记，返回恢复条数（自动分批，每批≤1000） */
    suspend fun restoreNotes(ids: List<String>): Int {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        var restored = 0
        for (chunk in ids.chunked(1000)) restored += client.restoreNotes(chunk).restored
        return restored
    }

    /** 最近删除列表：软删且未彻底清理的笔记（含剩余保留时间） */
    suspend fun listTrash(): TrashResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.listTrash()
    }

    /** 立即彻底删除回收站里的笔记（不可恢复） */
    suspend fun purgeNotes(ids: List<String>): Int {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        var purged = 0
        for (chunk in ids.chunked(1000)) purged += client.purgeNotes(chunk).purged
        return purged
    }

    /** 清空回收站：彻底删除全部软删笔记（不可恢复） */
    suspend fun emptyTrash(): Int {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.emptyTrash().purged
    }

    /** 洞察页统计（与 Web 共用 /api/stats） */
    suspend fun getStats(days: Int = 365, tzOffsetMinutes: Int): StatsResponse {
        val (client, mock) = api()
        if (mock) return StatsResponse()
        return client.getStats(days, tzOffsetMinutes)
    }

    /** 随机漫步：抽一条历史笔记（后端已排除敏感/示例/软删）；无可抽时返回 null */
    suspend fun getRandomNote(): Note? {
        val (client, mock) = api()
        if (mock) return null
        return client.getRandomNote()
    }

    /** 推送偏好（与 Web Push 共用） */
    suspend fun getPreferences(): PushPreferences {
        val (client, mock) = api()
        if (mock) return PushPreferences()
        return client.getPreferences()
    }

    suspend fun updatePreferences(dailyReviewPush: Boolean? = null, todoReminderPush: Boolean? = null): PushPreferences {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.updatePreferences(dailyReviewPush, todoReminderPush)
    }

    /**
     * 把设备时区同步到服务端偏好（与 web syncTimezone 同口径）：服务端分拣的裸时刻、PATCH 手输到期、
     * 今日待办 / 周月报边界都按 user_preferences.tz 算，没同步过的非东八区用户会按默认 +08:00 落库。
     * Mock / 未登录跳过；同 token 同时区只发一次；失败静默、下次启动再试。
     */
    suspend fun syncTimezone(zoneId: String = TimeZone.getDefault().id) {
        val s = settingsRepo.settings.first()
        if (s.mockMode || s.token.isBlank() || zoneId.isBlank()) return
        val marker = tzSyncMarker(s.token, zoneId)
        if (settingsRepo.tzSyncedMarker.first() == marker) return
        try {
            ApiClient(s.baseUrl, s.token).updatePreferences(tz = zoneId)
            settingsRepo.setTzSyncedMarker(marker)
        } catch (_: Exception) {
        }
    }

    /** 当天到期 + 已过期的未完成待办 */
    suspend fun getTodosToday(): TodosTodayResponse {
        val (client, mock) = api()
        if (mock) return TodosTodayResponse()
        return client.getTodosToday()
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

    /** 手动生成周报/月报；空数据窗口返回 report=null + 引导文案 */
    suspend fun generateReport(which: String = "this", period: String = "week"): ReportDetail {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.generateReport(which, period)
    }

    /** 永久注销账号并删除全部云端数据，成功后清本机登录状态 */
    suspend fun deleteAccount() {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        client.deleteAccount()
        logout()
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

    /** 鉴权取附件原件字节（图片/语音内联展示）：返回字节 + mime；命中本机缓存不发网 */
    suspend fun fetchNoteMedia(noteId: String, attachmentId: String): Pair<ByteArray, String> {
        val s = settingsRepo.settings.first()
        if (s.mockMode) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        val key = MediaCache.key(s.token, noteId, attachmentId)
        withContext(Dispatchers.IO) { mediaCache.get(key) }?.let { return it.bytes to it.mime }
        val (bytes, mime) = ApiClient(s.baseUrl, s.token).fetchNoteMedia(noteId, attachmentId)
        withContext(Dispatchers.IO) { mediaCache.put(key, bytes, mime) }
        return bytes to mime
    }

    /**
     * 鉴权取附件原件的落盘文件（语音直接喂 MediaPlayer）：命中磁盘缓存不发网也不进内存；
     * 未命中拉取后只落盘不占内存 LRU。文件属于缓存，调用方不删。
     */
    suspend fun fetchNoteMediaFile(noteId: String, attachmentId: String): File {
        val s = settingsRepo.settings.first()
        if (s.mockMode) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        val key = MediaCache.key(s.token, noteId, attachmentId)
        withContext(Dispatchers.IO) { mediaCache.file(key) }?.let { return it }
        val (bytes, mime) = ApiClient(s.baseUrl, s.token).fetchNoteMedia(noteId, attachmentId)
        return withContext(Dispatchers.IO) {
            mediaCache.put(key, bytes, mime, keepInMemory = false)
            mediaCache.file(key) ?: throw IOException("语音无法写入本机缓存，请清理存储空间后重试")
        }
    }

    /** 退出登录：清本机登录态 + 已缓存的私有原件 */
    suspend fun logout() {
        withContext(Dispatchers.IO) { mediaCache.clear() }
        settingsRepo.logout()
    }

    /**
     * 下载全量备份 zip：响应体边收边写进 [open] 打开的输出流，返回文件名。includeSensitive=true 时敏感笔记含明文；
     * [onProgress] 报已接收字节，协程取消会中断接收
     */
    suspend fun downloadBackup(
        includeSensitive: Boolean = false,
        password: String? = null,
        onProgress: DownloadProgress? = null,
        open: (fileName: String) -> OutputStream,
    ): String {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.downloadBackup(includeSensitive, password, onProgress, open)
    }

    /** 从备份 zip 恢复：返回恢复统计；[onProgress] 报上传进度，协程取消会中断上传 */
    suspend fun restoreBackup(bytes: ByteArray, fileName: String, onProgress: UploadProgress? = null): RestoreStats {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")
        return client.restoreBackup(bytes, fileName, onProgress)
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

    /** 语音上传：POST /api/ingest/media type=audio（后端 Whisper 转写成文字笔记） */
    suspend fun sendAudio(bytes: ByteArray, mime: String, fileName: String): MediaIngestResponse {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下语音上传不可用，请在设置中关闭 Mock")
        return client.ingestMedia("audio", bytes, mime, fileName)
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

    /** 重新生成恢复码（旧码作废，新码只显示一次） */
    suspend fun regenerateRecoveryCode(): String {
        val (client, mock) = api()
        if (mock) throw IllegalStateException("Mock 模式下不可用")
        return client.regenerateRecoveryCode()
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

/** 时区同步去重标记：换账号（token 前缀变）或换时区都会重新同步 */
fun tzSyncMarker(token: String, zoneId: String): String = "${token.take(8)}:$zoneId"
