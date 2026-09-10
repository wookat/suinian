package com.zalize.suinian.ui

import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.AppSettings
import com.zalize.suinian.data.api.ConflictException
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.DailyReviewItem
import com.zalize.suinian.data.InlineCommand
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NoteAttachment
import com.zalize.suinian.data.parseInlineCommand
import com.zalize.suinian.data.NotesViewLimits
import com.zalize.suinian.data.RestoreStats
import com.zalize.suinian.data.SendResult
import com.zalize.suinian.data.StaleDownloadCleaner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import com.zalize.suinian.ui.components.AudioPlayback
import com.zalize.suinian.ui.components.attachmentDownloadName
import com.zalize.suinian.ui.components.mediaStatusLine
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.OutputStream
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 删除后可撤销：服务端软删进「最近删除」，保留 30 天后真删，期间可恢复 */
data class UndoDelete(
    val message: String,
    val ids: List<String>,
)

data class NotesUiState(
    val notes: List<Note> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val category: String? = null,
    val query: String = "",
    val filterTag: String? = null,
    val filterSource: String? = null,
    val filterTime: TimeRange? = null,
    val availableTags: List<String> = emptyList(),
    /** 批量删除进度（done/total） */
    val batchProgress: Pair<Int, Int>? = null,
    val sending: Boolean = false,
    val toast: String? = null,
    val cursor: String? = null,
    val loadingMore: Boolean = false,
    val retryingLinkIds: Set<String> = emptySet(),
    /** 语音 / 图片 / 文件原地重试在途的笔记 */
    val retryingMediaIds: Set<String> = emptySet(),
    /** 列表刷新成功 / 网络恢复时递增，卡片附件因断网 / 5xx 失败的据此自动重拉 */
    val mediaReloadKey: Int = 0,
    /** 敏感标记 PATCH 在途的笔记：菜单项禁用防连发（R206 P2-2） */
    val sensitivePendingIds: Set<String> = emptySet(),
    val reviewItems: List<DailyReviewItem> = emptyList(),
    val selectionMode: Boolean = false,
    val selectedIds: Set<String> = emptySet(),
    /** 「全选全部匹配结果」：服务端按当前筛选条件执行，不限已加载项 */
    val allMatching: Boolean = false,
    val batchBusy: Boolean = false,
    val editingNote: Note? = null,
    val savingEdit: Boolean = false,
    /** 编辑保存遇 409 时的服务器最新副本：编辑器保持打开、用户输入不丢，展示对照供合并 */
    val editConflict: Note? = null,
    val seedingSamples: Boolean = false,
)

/** 空态一键示例笔记（与 Web 同内容同标签） */
const val SAMPLE_TAG = "示例"
/** 上传体积上限（与后端 MAX_MEDIA_BYTES 同值） */
const val MAX_MEDIA_BYTES = 10 * 1024 * 1024
/** 备份 zip 上限（与后端 MAX_RESTORE_BYTES 同值） */
const val MAX_RESTORE_BYTES = 200 * 1024 * 1024

/** 上传前超限的统一友好文案（R154 P2-1）：明确上限 + 当前大小，与 Web 同口径 */
fun mediaTooLargeToast(kind: String, size: Int): String =
    "${kind}过大：最多 ${MAX_MEDIA_BYTES / 1024 / 1024}MB，当前约 ${"%.1f".format(size / 1024.0 / 1024.0)}MB"

val SAMPLE_NOTES = listOf(
    "周末想试试手冲咖啡，先从 V60 滤杯开始研究，豆子买浅烘的",
    "明天下午三点前给牙医回电话，预约洗牙",
    "https://github.com/wookat/suinian 碎念开源仓库，有空研究下自部署",
)

class NotesViewModel(app: Application) : AndroidViewModel(app) {

    private val suinian = app as SuinianApp
    private val repo = suinian.repository
    val settingsRepo = suinian.settings

    private val _ui = MutableStateFlow(NotesUiState())
    val ui: StateFlow<NotesUiState> = _ui

    /** 删除撤销一次性事件：用 Channel 而非 state，避免重组时 LaunchedEffect 重启丢失撤销回调 */
    private val _undoEvents = Channel<UndoDelete>(Channel.BUFFERED)
    val undoEvents = _undoEvents.receiveAsFlow()

    val settings: StateFlow<AppSettings> = settingsRepo.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    val pendingCount: StateFlow<Int> = repo.pendingCount
        .stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    init {
        refresh()
        loadReview()
        loadTags()
        // 启动 / 登录 / 换地址 / 关 Mock 后把设备时区同步到服务端偏好（Repository 内去重、失败静默）
        viewModelScope.launch {
            settingsRepo.settings
                .map { Triple(it.token, it.baseUrl, it.mockMode) }
                .distinctUntilChanged()
                .collect { repo.syncTimezone() }
        }
    }

    /** 筛选用标签列表：锦上添花，失败静默隐藏 */
    fun loadTags() {
        viewModelScope.launch {
            try {
                _ui.value = _ui.value.copy(availableTags = repo.listTags().take(12).map { it.tag })
            } catch (_: Exception) {
            }
        }
    }

    /** 今日回顾：锦上添花，失败静默隐藏 */
    fun loadReview() {
        viewModelScope.launch {
            try {
                _ui.value = _ui.value.copy(reviewItems = repo.getTodayReview().items)
            } catch (_: Exception) {
            }
        }
    }

    private var refreshJob: Job? = null

    /** clearFirst=true 时先清空列表（如首登切换 Mock→真实后端），避免旧数据闪现 */
    fun refresh(clearFirst: Boolean = false) {
        val s = _ui.value
        _ui.value = if (clearFirst) s.copy(notes = emptyList(), cursor = null, loading = true, error = null)
        else s.copy(loading = true, error = null)
        // 取消未完成的上一次刷新，避免陆续完成时旧结果（如首启 Mock 数据）覆盖新结果
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            try {
                val page = repo.list(
                    category = s.category,
                    tag = s.filterTag,
                    q = s.query.ifBlank { null },
                    source = s.filterSource,
                    from = s.filterTime?.fromParam(),
                )
                _ui.value = _ui.value.copy(
                    notes = page.notes,
                    loading = false,
                    cursor = page.cursor,
                    mediaReloadKey = _ui.value.mediaReloadKey + 1,
                )
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    /** 系统网络恢复（新网络变为默认）：列表处于错误态则重拉列表（成功后附件随之重拉），否则只让断网时失败的附件重拉 */
    fun onNetworkAvailable() {
        val s = _ui.value
        if (s.error != null && !s.loading) {
            refresh()
        } else {
            _ui.value = s.copy(mediaReloadKey = s.mediaReloadKey + 1)
        }
    }

    private var triagePollJob: Job? = null

    /**
     * 分拣结论出来后自动刷新（R154 P2-4，对齐 Web timeline 的 pollTriage）：
     * 新笔记 category 为空时每 2s 拉一次当前筛选下的首页，最多 15 次，
     * 全部出分类即提前停止；失败静默跳过本次。
     */
    fun pollTriage() {
        triagePollJob?.cancel()
        triagePollJob = viewModelScope.launch {
            // 等 refresh 拉到含新笔记的列表后再判断是否有待分拣项
            refreshJob?.join()
            if (_ui.value.notes.none { it.category == null }) return@launch
            repeat(15) {
                delay(2000)
                if (_ui.value.notes.none { it.category == null }) return@launch
                try {
                    val s = _ui.value
                    val page = repo.list(
                        category = s.category,
                        tag = s.filterTag,
                        q = s.query.ifBlank { null },
                        source = s.filterSource,
                        from = s.filterTime?.fromParam(),
                    )
                    val fresh = page.notes.associateBy { it.id }
                    _ui.value = _ui.value.copy(notes = _ui.value.notes.map { fresh[it.id] ?: it })
                } catch (_: Exception) {
                }
            }
        }
    }

    fun loadMore() {
        val s = _ui.value
        val cursor = s.cursor ?: return
        if (s.loading || s.loadingMore) return
        _ui.value = s.copy(loadingMore = true)
        viewModelScope.launch {
            try {
                val page = repo.list(
                    category = s.category,
                    tag = s.filterTag,
                    q = s.query.ifBlank { null },
                    source = s.filterSource,
                    from = s.filterTime?.fromParam(),
                    cursor = cursor,
                )
                val existing = _ui.value.notes
                val existingIds = existing.map { it.id }.toSet()
                val merged = existing + page.notes.filter { it.id !in existingIds }
                _ui.value = _ui.value.copy(notes = merged, loadingMore = false, cursor = page.cursor)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loadingMore = false, toast = "加载更多失败：${e.message ?: "网络错误"}")
            }
        }
    }

    fun setCategory(category: String?) {
        _ui.value = _ui.value.copy(category = category)
        refresh()
    }

    fun setQuery(q: String) {
        _ui.value = _ui.value.copy(query = q)
    }

    fun search() = refresh()

    fun setFilterTag(tag: String?) {
        _ui.value = _ui.value.copy(filterTag = tag)
        refresh()
    }

    fun setFilterSource(source: String?) {
        _ui.value = _ui.value.copy(filterSource = source)
        refresh()
    }

    fun setFilterTime(range: TimeRange?) {
        _ui.value = _ui.value.copy(filterTime = range)
        refresh()
    }

    fun clearFilters() {
        _ui.value = _ui.value.copy(filterTag = null, filterSource = null, filterTime = null)
        refresh()
    }

    /** 设置页轮换 API token（成功后新 token 已保存到本机） */
    suspend fun rotateApiToken(): String = repo.rotateToken()

    /** 重新生成恢复码（旧码作废，新码只显示一次） */
    suspend fun regenerateRecoveryCode(): String = repo.regenerateRecoveryCode()

    /** 推送偏好（与 Web Push 共用，存后端） */
    suspend fun getPushPreferences() = repo.getPreferences()

    suspend fun updatePushPreferences(dailyReviewPush: Boolean? = null, todoReminderPush: Boolean? = null) =
        repo.updatePreferences(dailyReviewPush, todoReminderPush)

    /** 永久注销账号：删除云端全部数据并清本机登录状态 */
    suspend fun deleteAccount() {
        AudioPlayback.stop()
        repo.deleteAccount()
    }

    /** 退出登录：清登录态与本机缓存的私有附件 */
    suspend fun logout() {
        AudioPlayback.stop()
        repo.logout()
    }

    /** 最近删除列表（软删且未彻底清理，含剩余保留时间） */
    suspend fun listTrash() = repo.listTrash()

    /** 从回收站恢复；成功后刷新时间流 */
    suspend fun restoreTrashNotes(ids: List<String>): Int {
        val restored = repo.restoreNotes(ids)
        if (restored > 0) refresh()
        return restored
    }

    /** 立即彻底删除回收站里的笔记（不可恢复） */
    suspend fun purgeNotes(ids: List<String>): Int = repo.purgeNotes(ids)

    /** 清空回收站（不可恢复） */
    suspend fun emptyTrash(): Int = repo.emptyTrash()

    /** 洞察页统计（与 Web 共用 /api/stats） */
    suspend fun getStats(days: Int = 365, tzOffsetMinutes: Int) = repo.getStats(days, tzOffsetMinutes)

    /** 随机漫步：抽一条历史笔记；无可抽时返回 null */
    suspend fun getRandomNote() = repo.getRandomNote()

    fun toggleTodo(note: Note) {
        val target = !(note.todoDone ?: false)
        val optimistic = _ui.value.notes.map { if (it.id == note.id) it.copy(todoDone = target) else it }
        _ui.value = _ui.value.copy(notes = optimistic)
        viewModelScope.launch {
            try {
                repo.setTodoDone(note.id, target)
            } catch (e: Exception) {
                val rolledBack = _ui.value.notes.map { if (it.id == note.id) it.copy(todoDone = note.todoDone) else it }
                _ui.value = _ui.value.copy(notes = rolledBack, toast = e.message ?: "操作失败")
            }
        }
    }

    /** 手动标记/取消敏感：乐观更新，在途去重（pending 期间忽略重复点击），失败回滚 */
    fun toggleSensitive(note: Note) {
        if (note.id in _ui.value.sensitivePendingIds) return
        val target = !note.isSensitive
        val optimistic = _ui.value.notes.map { if (it.id == note.id) it.copy(isSensitive = target) else it }
        _ui.value = _ui.value.copy(
            notes = optimistic,
            sensitivePendingIds = _ui.value.sensitivePendingIds + note.id,
        )
        viewModelScope.launch {
            try {
                val updated = repo.setSensitive(note.id, target)
                _ui.value = _ui.value.copy(
                    notes = if (updated != null) {
                        _ui.value.notes.map { if (it.id == note.id) updated else it }
                    } else _ui.value.notes,
                    sensitivePendingIds = _ui.value.sensitivePendingIds - note.id,
                    toast = if (updated != null) {
                        if (target) "已标记敏感" else "已取消敏感"
                    } else _ui.value.toast,
                )
            } catch (e: Exception) {
                val rolledBack = _ui.value.notes.map { if (it.id == note.id) note else it }
                _ui.value = _ui.value.copy(
                    notes = rolledBack,
                    sensitivePendingIds = _ui.value.sensitivePendingIds - note.id,
                    toast = e.message ?: "操作失败",
                )
            }
        }
    }

    /** 链接卡重试抓取：成功后用后端返回的笔记替换 */
    fun retryLink(note: Note) {
        if (note.id in _ui.value.retryingLinkIds) return
        _ui.value = _ui.value.copy(retryingLinkIds = _ui.value.retryingLinkIds + note.id)
        viewModelScope.launch {
            try {
                val updated = repo.refetchLink(note.id)
                _ui.value = _ui.value.copy(
                    notes = if (updated != null) {
                        _ui.value.notes.map { if (it.id == note.id) updated else it }
                    } else _ui.value.notes,
                    retryingLinkIds = _ui.value.retryingLinkIds - note.id,
                    toast = "已重新抓取",
                )
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    retryingLinkIds = _ui.value.retryingLinkIds - note.id,
                    toast = e.message ?: "重试失败",
                )
            }
        }
    }

    /** 语音 / 图片 / 文件卡原地重试：服务端用存档原件重跑，成功后用返回的笔记替换；失败保留失败态、toast 服务端原因（频率 / 仍失败 / 原件不在） */
    fun retryMedia(note: Note) {
        if (note.id in _ui.value.retryingMediaIds) return
        _ui.value = _ui.value.copy(retryingMediaIds = _ui.value.retryingMediaIds + note.id)
        viewModelScope.launch {
            try {
                val updated = repo.retryMedia(note.id)
                _ui.value = _ui.value.copy(
                    notes = if (updated != null) {
                        _ui.value.notes.map { if (it.id == note.id) updated else it }
                    } else _ui.value.notes,
                    retryingMediaIds = _ui.value.retryingMediaIds - note.id,
                    toast = mediaStatusLine(note)?.doneToast ?: "已重试",
                )
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    retryingMediaIds = _ui.value.retryingMediaIds - note.id,
                    toast = e.message ?: "重试失败",
                )
            }
        }
    }

    /** 从文件选择器上传文档：POST /api/ingest/media type=file */
    fun uploadFile(bytes: ByteArray, mime: String, fileName: String) {
        if (bytes.size > MAX_MEDIA_BYTES) {
            _ui.value = _ui.value.copy(toast = mediaTooLargeToast("文件", bytes.size))
            return
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            try {
                repo.sendFile(bytes, mime, fileName)
                _ui.value = _ui.value.copy(sending = false, toast = "已上传，AI 正在提取文件内容")
                refresh()
                pollTriage()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(sending = false, toast = e.message ?: "文件上传失败")
            }
        }
    }

    /** 从相册/拍照上传图片：POST /api/ingest/media type=image */
    fun uploadImage(bytes: ByteArray, mime: String, fileName: String) {
        if (bytes.size > MAX_MEDIA_BYTES) {
            _ui.value = _ui.value.copy(toast = mediaTooLargeToast("图片", bytes.size))
            return
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            try {
                repo.sendImage(bytes, mime, fileName)
                _ui.value = _ui.value.copy(sending = false, toast = "已上传，AI 正在识别图片内容")
                refresh()
                pollTriage()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(sending = false, toast = e.message ?: "图片上传失败")
            }
        }
    }

    /** 录音上传：POST /api/ingest/media type=audio（Whisper 转写） */
    fun uploadAudio(bytes: ByteArray, mime: String, fileName: String) {
        if (bytes.size > MAX_MEDIA_BYTES) {
            _ui.value = _ui.value.copy(toast = mediaTooLargeToast("录音", bytes.size))
            return
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            try {
                repo.sendAudio(bytes, mime, fileName)
                _ui.value = _ui.value.copy(sending = false, toast = "已上传，AI 正在转写录音")
                refresh()
                pollTriage()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(sending = false, toast = e.message ?: "录音上传失败")
            }
        }
    }

    /** 鉴权取附件原件字节（图片/语音内联展示），供 NoteCard 使用 */
    suspend fun fetchMedia(noteId: String, attachmentId: String): Pair<ByteArray, String> =
        repo.fetchNoteMedia(noteId, attachmentId)

    /** 语音附件的落盘缓存文件，直接喂 MediaPlayer */
    suspend fun fetchMediaFile(noteId: String, attachmentId: String): java.io.File =
        repo.fetchNoteMediaFile(noteId, attachmentId)

    /** 下载文件笔记原件到系统下载目录 */
    fun downloadFile(note: Note) {
        val fileName = safeDownloadName(note.meta?.fileName)
        _ui.value = _ui.value.copy(toast = "开始下载…")
        viewModelScope.launch {
            var target: DownloadTarget? = null
            try {
                val (bytes, mime) = repo.downloadNoteFile(note.id)
                StaleDownloadCleaner.ensureCleaned(getApplication())
                target = openDownload(fileName, mime)
                target.stream.use { it.write(bytes) }
                val saved = target.commit()
                target = null
                _ui.value = _ui.value.copy(toast = savedToLabel(saved.fileName, saved.inAppDir))
            } catch (e: Exception) {
                target?.discard()
                if (e is CancellationException) throw e
                _ui.value = _ui.value.copy(toast = e.message ?: "下载失败")
            }
        }
    }

    /** 语音 / 图片附件原件存到系统下载目录（语音：本机放不出来换其他应用打开；图片：保存原图）；命中落盘缓存不发网 */
    fun downloadAttachment(note: Note, att: NoteAttachment) {
        val fileName = safeDownloadName(attachmentDownloadName(att.name, att.mime, note.id, if (note.rawType == "image") "image" else "voice"))
        _ui.value = _ui.value.copy(toast = "开始下载…")
        viewModelScope.launch {
            var target: DownloadTarget? = null
            try {
                val file = repo.fetchNoteMediaFile(note.id, att.id)
                StaleDownloadCleaner.ensureCleaned(getApplication())
                target = openDownload(fileName, att.mime ?: "application/octet-stream")
                withContext(Dispatchers.IO) { file.inputStream().use { input -> target.stream.use { input.copyTo(it) } } }
                val saved = target.commit()
                target = null
                _ui.value = _ui.value.copy(toast = savedToLabel(saved.fileName, saved.inAppDir))
            } catch (e: Exception) {
                target?.discard()
                if (e is CancellationException) throw e
                _ui.value = _ui.value.copy(toast = e.message ?: "下载失败")
            }
        }
    }

    /**
     * 把附件原件分享给其他应用（ACTION_SEND 系统选择器）：缓存文件按真实文件名复制到 cacheDir/share 再经 FileProvider 授权，
     * 接收方拿到的是带正确后缀的名字而不是缓存键 .bin。拿到 Intent 后由界面层 [launch]。
     */
    fun shareAttachment(note: Note, att: NoteAttachment, launch: (Intent) -> Unit) {
        val context = getApplication<Application>()
        val fileName = attachmentDownloadName(att.name, att.mime, note.id, if (note.rawType == "image") "image" else "voice")
        val mime = (att.mime ?: "application/octet-stream").substringBefore(';')
        viewModelScope.launch {
            try {
                val cached = repo.fetchNoteMediaFile(note.id, att.id)
                val shared = withContext(Dispatchers.IO) {
                    val dir = java.io.File(context.cacheDir, "share").apply { mkdirs() }
                    val stale = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
                    dir.listFiles()?.filter { it.name != fileName && it.lastModified() < stale }?.forEach { it.delete() }
                    java.io.File(dir, fileName).also { cached.copyTo(it, overwrite = true) }
                }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", shared)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                launch(Intent.createChooser(send, "分享原图"))
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(toast = e.message ?: "分享失败")
            }
        }
    }

    fun deleteNote(note: Note) {
        AudioPlayback.stopIfNote(note.id)
        val prev = _ui.value.notes
        _ui.value = _ui.value.copy(notes = prev.filter { it.id != note.id })
        viewModelScope.launch {
            try {
                repo.delete(note.id)
                _undoEvents.send(UndoDelete("已删除", listOf(note.id)))
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(notes = prev, toast = e.message ?: "删除失败")
            }
        }
    }

    /** 撤销删除：调后端恢复接口（服务端软删窗口内有效） */
    fun undoDelete(undo: UndoDelete) {
        viewModelScope.launch {
            try {
                val restored = repo.restoreNotes(undo.ids)
                _ui.value = _ui.value.copy(toast = if (restored > 0) "已恢复 $restored 条" else "已超出可撤销时间，无法恢复")
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(toast = e.message ?: "撤销失败")
            }
        }
    }

    /** 速记发送；内联指令 ?问题 由 onAsk 路由到问答 tab，!内容 原样保存，#标签 内容 手动打标 */
    fun quickSend(text: String, onAsk: ((String) -> Unit)? = null) {
        val content = text.trim()
        if (content.isEmpty()) return
        if (content.length > NotesViewLimits.MAX_CONTENT_CHARS) {
            _ui.value = _ui.value.copy(
                toast = "内容过长：最多 ${NotesViewLimits.MAX_CONTENT_CHARS} 字符，当前 ${content.length} 字符"
            )
            return
        }
        val command = parseInlineCommand(content)
        if (command is InlineCommand.Ask) {
            if (command.question.isBlank()) return
            onAsk?.invoke(command.question)
            return
        }
        val req = when (command) {
            is InlineCommand.Raw -> {
                if (command.content.isBlank()) return
                CreateNoteRequest(source = "android", rawType = "text", content = command.content, skipTriage = true)
            }
            is InlineCommand.Tags -> {
                if (command.content.isBlank()) return
                CreateNoteRequest(source = "android", rawType = "text", content = command.content, tags = command.tags)
            }
            else -> {
                val isLink = content.startsWith("http://") || content.startsWith("https://")
                CreateNoteRequest(
                    source = "android",
                    rawType = if (isLink) "link" else "text",
                    content = content,
                    url = if (isLink) content else null,
                )
            }
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            val result = repo.send(req)
            val toast = when (result) {
                is SendResult.Sent -> when (command) {
                    is InlineCommand.Raw -> "已原样保存（不经 AI 分拣）"
                    is InlineCommand.Tags -> "已记下，标签：" + command.tags.joinToString(" ") { "#$it" }
                    else -> "已记下"
                }
                SendResult.Queued -> "已离线暂存，稍后自动重试"
            }
            _ui.value = _ui.value.copy(sending = false, toast = toast)
            refresh()
            pollTriage()
        }
    }

    /** 空态一键丢入示例笔记（打 #示例 标签，可随时一键清除） */
    fun seedSamples() {
        if (_ui.value.seedingSamples) return
        _ui.value = _ui.value.copy(seedingSamples = true)
        viewModelScope.launch {
            try {
                for (content in SAMPLE_NOTES) {
                    val isLink = content.startsWith("http://") || content.startsWith("https://")
                    repo.send(
                        CreateNoteRequest(
                            source = "android",
                            rawType = if (isLink) "link" else "text",
                            content = content,
                            url = if (isLink) content else null,
                            tags = listOf(SAMPLE_TAG),
                        )
                    )
                }
                _ui.value = _ui.value.copy(seedingSamples = false, toast = "已丢入 ${SAMPLE_NOTES.size} 条示例，AI 正在自动分拣…")
                refresh()
                pollTriage()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(seedingSamples = false, toast = e.message ?: "示例创建失败")
            }
        }
    }

    /** 一键清除带 #示例 标签的笔记 */
    fun clearSamples() {
        val ids = _ui.value.notes.filter { SAMPLE_TAG in it.tags }.map { it.id }
        if (ids.isEmpty()) return
        viewModelScope.launch {
            try {
                val res = repo.batchNotes("delete", ids)
                _ui.value = _ui.value.copy(
                    notes = _ui.value.notes.filter { it.id !in ids },
                    toast = "已清除 ${res.affected} 条示例笔记",
                )
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(toast = e.message ?: "清除失败")
            }
        }
    }

    private val _backupDownload = MutableStateFlow<BackupDownloadState>(BackupDownloadState.Idle)
    /** 备份下载进度 / 结果：挂在 ViewModel 上，离开设置页不中断下载、回来仍能看到 */
    val backupDownload: StateFlow<BackupDownloadState> = _backupDownload
    private var backupDownloadJob: Job? = null

    /**
     * 下载全量备份 zip 到系统下载目录，边收边写（不整包进内存）；同时只允许一次。
     * includeSensitive=true 时敏感笔记含明文。取消 / 失败都删掉半个文件，下载目录不会留下打不开的 zip
     */
    fun startBackupDownload(includeSensitive: Boolean = false, password: String? = null) {
        if (backupDownloadJob?.isActive == true) return
        _backupDownload.value = BackupDownloadState.Running(0, -1)
        backupDownloadJob = viewModelScope.launch {
            var target: DownloadTarget? = null
            try {
                StaleDownloadCleaner.ensureCleaned(getApplication())
                var lastStep = -1L
                repo.downloadBackup(
                    includeSensitive,
                    password,
                    onProgress = { received, total, estimate ->
                        val step = backupDownloadStep(received, total, estimate)
                        if (step != lastStep) {
                            lastStep = step
                            _backupDownload.update {
                                if (it is BackupDownloadState.Running) BackupDownloadState.Running(received, total, estimate) else it
                            }
                        }
                    },
                    open = { name -> openDownload(name, "application/zip").also { target = it }.stream },
                )
                val saved = target?.commit() ?: throw IllegalStateException("备份下载失败，请稍后重试")
                target = null
                _backupDownload.value = saved
            } catch (e: CancellationException) {
                target?.discard()
                _backupDownload.value = BackupDownloadState.Failed(BACKUP_DOWNLOAD_CANCELLED)
                throw e
            } catch (e: Exception) {
                target?.discard()
                _backupDownload.value = BackupDownloadState.Failed(e.message ?: "备份下载失败，请稍后重试")
            }
        }
    }

    fun cancelBackupDownload() {
        backupDownloadJob?.cancel()
    }

    fun dismissBackupDownloadResult() {
        if (backupDownloadJob?.isActive != true) _backupDownload.value = BackupDownloadState.Idle
    }

    /**
     * 下载目录里一个正在写的文件：Q+ 是 IS_PENDING 的 MediaStore 行（对其他应用不可见），旧系统是应用外部目录下的 .part 文件、完成后才改成最终名。
     * commit 返回实际落盘的文件名（同名时系统 / 本地都改成「name (1).zip」，不覆盖上一份）与可分享的 content Uri
     */
    private inner class DownloadTarget(
        val stream: OutputStream,
        private val uri: Uri?,
        private val file: java.io.File?,
        private val requestedName: String,
    ) {
        fun commit(): BackupDownloadState.Done {
            val context = getApplication<Application>()
            val u = uri
            if (u != null) {
                val resolver = context.contentResolver
                val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                resolver.update(u, values, null, null)
                val actualName = runCatching {
                    resolver.query(u, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) c.getString(0) else null
                    }
                }.getOrNull()
                return BackupDownloadState.Done(actualName ?: requestedName, u, inAppDir = false)
            }
            val part = file ?: throw IllegalStateException("无法保存下载文件")
            val dest = java.io.File(part.parentFile, uniqueDownloadName(requestedName) { java.io.File(part.parentFile, it).exists() })
            if (!part.renameTo(dest)) throw IllegalStateException("无法保存下载文件")
            val shareUri = runCatching {
                FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", dest)
            }.getOrNull()
            return BackupDownloadState.Done(dest.name, shareUri, inAppDir = true)
        }

        fun discard() {
            runCatching { stream.close() }
            val u = uri
            if (u != null) runCatching { getApplication<Application>().contentResolver.delete(u, null, null) }
            file?.delete()
        }
    }

    private fun openDownload(fileName: String, mime: String): DownloadTarget {
        val context = getApplication<Application>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, mime.substringBefore(';'))
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("无法创建下载文件")
            val stream = resolver.openOutputStream(uri)
                ?: run { resolver.delete(uri, null, null); throw IllegalStateException("无法写入下载文件") }
            return DownloadTarget(stream, uri, null, fileName)
        }
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IllegalStateException("存储不可用")
        val part = java.io.File(dir, fileName + StaleDownloadCleaner.PART_SUFFIX)
        return DownloadTarget(part.outputStream(), null, part, fileName)
    }

    private val _restore = MutableStateFlow<RestoreState>(RestoreState.Idle)
    /** 备份恢复进度 / 结果：挂在 ViewModel 上，离开设置页不中断上传、回来仍能看到 */
    val restore: StateFlow<RestoreState> = _restore
    private var restoreJob: Job? = null

    /** 读取所选 zip 并上传恢复；同时只允许一次 */
    fun startRestore(uri: Uri) {
        if (restoreJob?.isActive == true) return
        _restore.value = RestoreState.Reading
        restoreJob = viewModelScope.launch {
            try {
                val bytes = withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openInputStream(uri)?.use { it.readBytes() }
                } ?: throw IllegalStateException("无法读取所选文件")
                if (bytes.size > MAX_RESTORE_BYTES) {
                    _restore.value = RestoreState.Failed("备份文件过大：最大支持 ${MAX_RESTORE_BYTES / 1024 / 1024}MB")
                    return@launch
                }
                _restore.value = RestoreState.Running(0, bytes.size.toLong())
                var lastPercent = -1
                val stats = repo.restoreBackup(bytes, "backup.zip") { sent, total ->
                    val next = RestoreState.Running(sent, total)
                    val percent = restorePercent(next)
                    if (percent != lastPercent || next.uploaded) {
                        lastPercent = percent
                        _restore.update { if (it is RestoreState.Running) next else it }
                    }
                }
                _restore.value = RestoreState.Done(stats)
                refresh()
            } catch (e: CancellationException) {
                _restore.update { RestoreState.Failed(restoreCancelledMessage(it)) }
                throw e
            } catch (e: Exception) {
                _restore.value = RestoreState.Failed(e.message ?: "恢复失败，请稍后重试")
            }
        }
    }

    /** 中断恢复：上传未完成则服务端不会导入；已上传完则只是不再等结果 */
    fun cancelRestore() {
        restoreJob?.cancel()
    }

    fun dismissRestoreResult() {
        if (restoreJob?.isActive != true) _restore.value = RestoreState.Idle
    }

    fun showToast(message: String) {
        _ui.value = _ui.value.copy(toast = message)
    }

    fun consumeToast() {
        _ui.value = _ui.value.copy(toast = null)
    }

    // ---- 多选批量操作 ----

    fun enterSelection(note: Note) {
        _ui.value = _ui.value.copy(selectionMode = true, selectedIds = setOf(note.id))
    }

    fun toggleSelect(note: Note) {
        val cur = _ui.value.selectedIds
        val next = if (note.id in cur) cur - note.id else cur + note.id
        _ui.value = _ui.value.copy(selectedIds = next, allMatching = false)
    }

    /** 全选/清空已加载项 */
    fun toggleSelectAllLoaded() {
        val s = _ui.value
        if (s.allMatching || s.selectedIds.size == s.notes.size) {
            _ui.value = s.copy(selectedIds = emptySet(), allMatching = false)
        } else {
            _ui.value = s.copy(selectedIds = s.notes.map { it.id }.toSet())
        }
    }

    /** 选中全部匹配结果（服务端按当前筛选条件执行） */
    fun selectAllMatching() {
        _ui.value = _ui.value.copy(allMatching = true)
    }

    fun exitSelection() {
        _ui.value = _ui.value.copy(selectionMode = false, selectedIds = emptySet(), allMatching = false)
    }

    fun batchDelete() {
        AudioPlayback.stop()
        val s = _ui.value
        if (s.allMatching) {
            _ui.value = s.copy(batchBusy = true, batchProgress = null)
            viewModelScope.launch {
                try {
                    // 全部匹配：单批上限 1000 条，remaining > 0 时自动续删直到清空
                    val deletedIds = mutableListOf<String>()
                    var affected = 0
                    var total = -1
                    while (true) {
                        val res = repo.batchNotesByFilter(
                            "delete", s.category, s.query.ifBlank { null },
                            s.filterTag, s.filterSource, s.filterTime?.fromParam(),
                        )
                        affected += res.affected
                        deletedIds += res.ids
                        if (total < 0) total = res.affected + res.remaining
                        _ui.value = _ui.value.copy(batchProgress = affected to total)
                        if (res.remaining <= 0 || res.affected == 0) break
                    }
                    _ui.value = _ui.value.copy(
                        batchBusy = false,
                        batchProgress = null,
                        selectionMode = false,
                        selectedIds = emptySet(),
                        allMatching = false,
                    )
                    _undoEvents.send(UndoDelete("已删除全部匹配的 $affected 条", deletedIds))
                    refresh()
                } catch (e: Exception) {
                    _ui.value = _ui.value.copy(batchBusy = false, batchProgress = null, toast = e.message ?: "批量删除失败")
                }
            }
            return
        }
        val ids = s.selectedIds.toList()
        if (ids.isEmpty()) return
        _ui.value = _ui.value.copy(batchBusy = true, batchProgress = 0 to ids.size)
        viewModelScope.launch {
            try {
                // 分块提交，每块完成后更新进度
                var affected = 0
                var done = 0
                for (chunk in ids.chunked(100)) {
                    affected += repo.batchNotes("delete", chunk).affected
                    done += chunk.size
                    _ui.value = _ui.value.copy(batchProgress = done to ids.size)
                }
                _ui.value = _ui.value.copy(
                    batchBusy = false,
                    batchProgress = null,
                    selectionMode = false,
                    selectedIds = emptySet(),
                    notes = _ui.value.notes.filter { it.id !in ids },
                )
                _undoEvents.send(UndoDelete("已删除 $affected 条", ids))
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(batchBusy = false, batchProgress = null, toast = e.message ?: "批量删除失败")
                refresh()
            }
        }
    }

    fun batchAddTag(tag: String) {
        val s = _ui.value
        val t = tag.trim().removePrefix("#")
        if (t.isEmpty()) return
        if (s.allMatching) {
            _ui.value = s.copy(batchBusy = true)
            viewModelScope.launch {
                try {
                    val res = repo.batchNotesByFilter(
                        "add_tags", s.category, s.query.ifBlank { null },
                        s.filterTag, s.filterSource, s.filterTime?.fromParam(),
                        tags = listOf(t),
                    )
                    _ui.value = _ui.value.copy(
                        batchBusy = false,
                        selectionMode = false,
                        selectedIds = emptySet(),
                        allMatching = false,
                        toast = "已为全部匹配的 ${res.affected} 条加上 #$t",
                    )
                    refresh()
                } catch (e: Exception) {
                    _ui.value = _ui.value.copy(batchBusy = false, toast = e.message ?: "批量打标失败")
                }
            }
            return
        }
        val ids = s.selectedIds.toList()
        if (ids.isEmpty()) return
        _ui.value = _ui.value.copy(batchBusy = true)
        viewModelScope.launch {
            try {
                val res = repo.batchNotes("add_tags", ids, tags = listOf(t))
                _ui.value = _ui.value.copy(
                    batchBusy = false,
                    selectionMode = false,
                    selectedIds = emptySet(),
                    toast = "已给 ${res.affected} 条加标签 #$t",
                )
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(batchBusy = false, toast = e.message ?: "批量打标失败")
            }
        }
    }

    fun batchSetCategory(category: String) {
        val s = _ui.value
        if (s.allMatching) {
            _ui.value = s.copy(batchBusy = true)
            viewModelScope.launch {
                try {
                    val res = repo.batchNotesByFilter(
                        "set_category", s.category, s.query.ifBlank { null },
                        s.filterTag, s.filterSource, s.filterTime?.fromParam(),
                        setCategory = category,
                    )
                    _ui.value = _ui.value.copy(
                        batchBusy = false,
                        selectionMode = false,
                        selectedIds = emptySet(),
                        allMatching = false,
                        toast = "已将全部匹配的 ${res.affected} 条改分类",
                    )
                    refresh()
                } catch (e: Exception) {
                    _ui.value = _ui.value.copy(batchBusy = false, toast = e.message ?: "批量改分类失败")
                }
            }
            return
        }
        val ids = s.selectedIds.toList()
        if (ids.isEmpty()) return
        _ui.value = _ui.value.copy(batchBusy = true)
        viewModelScope.launch {
            try {
                val res = repo.batchNotes("set_category", ids, category = category)
                _ui.value = _ui.value.copy(
                    batchBusy = false,
                    selectionMode = false,
                    selectedIds = emptySet(),
                    toast = "已改分类 ${res.affected} 条",
                )
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(batchBusy = false, toast = e.message ?: "批量改分类失败")
            }
        }
    }

    // ---- 笔记编辑 ----

    fun openEditor(note: Note) {
        _ui.value = _ui.value.copy(editingNote = note, editConflict = null)
    }

    fun closeEditor() {
        _ui.value = _ui.value.copy(editingNote = null, editConflict = null)
    }

    /** 用户在冲突对照中选择了处置方式后收起对照条 */
    fun dismissEditConflict() {
        _ui.value = _ui.value.copy(editConflict = null)
    }

    fun saveEdit(
        note: Note,
        content: String,
        title: String,
        category: String?,
        tags: List<String>,
        todoDue: String?,
    ) {
        _ui.value = _ui.value.copy(savingEdit = true)
        viewModelScope.launch {
            try {
                val updated = repo.updateNote(
                    id = note.id,
                    content = content.takeIf { it != note.content },
                    title = title.takeIf { it != (note.title ?: "") },
                    category = category.takeIf { it != null && it != note.category },
                    tags = tags.takeIf { it != note.tags },
                    todoDue = todoDue.takeIf { !it.isNullOrBlank() && it != note.todoDue },
                    clearTodoDue = todoDue.isNullOrBlank() && !note.todoDue.isNullOrBlank(),
                    baseUpdatedAt = note.updatedAt,
                )
                _ui.value = _ui.value.copy(
                    savingEdit = false,
                    editingNote = null,
                    editConflict = null,
                    notes = if (updated != null) {
                        _ui.value.notes.map { if (it.id == note.id) updated else it }
                    } else _ui.value.notes,
                    toast = "已保存",
                )
                if (updated == null) refresh()
            } catch (e: ConflictException) {
                // 冲突：编辑器保持打开、用户输入不丢；带回最新副本供对照合并，重提基于最新 updated_at
                val latest = e.latest
                _ui.value = _ui.value.copy(
                    savingEdit = false,
                    editingNote = latest ?: _ui.value.editingNote,
                    editConflict = latest ?: note,
                    notes = if (latest != null) _ui.value.notes.map { if (it.id == note.id) latest else it } else _ui.value.notes,
                )
                if (latest == null) refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(savingEdit = false, toast = e.message ?: "保存失败")
            }
        }
    }
}
