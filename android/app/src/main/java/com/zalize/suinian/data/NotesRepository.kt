package com.zalize.suinian.data

import android.content.Context
import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.local.PendingNote
import com.zalize.suinian.data.local.PendingNoteDao
import com.zalize.suinian.sync.SyncWorker
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first

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
                PendingNote(source = req.source, rawType = req.rawType, content = req.content, url = req.url)
            )
            SyncWorker.schedule(context)
            SendResult.Queued
        }
    }

    suspend fun list(category: String?, tag: String?, q: String?): NotesPage {
        val (client, mock) = api()
        if (mock) return MockStore.list(category, tag, q)
        return client.listNotes(category = category, tag = tag, q = q)
    }

    /** 重试队列：全部成功返回 true */
    suspend fun flushPending(): Boolean {
        val (client, mock) = api()
        val pending = pendingDao.all()
        var allOk = true
        for (p in pending) {
            try {
                val req = CreateNoteRequest(source = p.source, rawType = p.rawType, content = p.content, url = p.url)
                if (mock) MockStore.create(req) else client.createNote(req)
                pendingDao.delete(p)
            } catch (e: Exception) {
                allOk = false
            }
        }
        return allOk
    }
}
