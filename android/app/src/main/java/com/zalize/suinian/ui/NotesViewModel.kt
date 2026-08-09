package com.zalize.suinian.ui

import android.app.Application
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.AppSettings
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.DailyReviewItem
import com.zalize.suinian.data.InlineCommand
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.parseInlineCommand
import com.zalize.suinian.data.NotesViewLimits
import com.zalize.suinian.data.RestoreStats
import com.zalize.suinian.data.SendResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

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
    val reviewItems: List<DailyReviewItem> = emptyList(),
    val selectionMode: Boolean = false,
    val selectedIds: Set<String> = emptySet(),
    /** 「全选全部匹配结果」：服务端按当前筛选条件执行，不限已加载项 */
    val allMatching: Boolean = false,
    val batchBusy: Boolean = false,
    val editingNote: Note? = null,
    val savingEdit: Boolean = false,
    val seedingSamples: Boolean = false,
)

/** 空态一键示例笔记（与 Web 同内容同标签） */
const val SAMPLE_TAG = "示例"
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

    fun refresh() {
        val s = _ui.value
        _ui.value = s.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val page = repo.list(
                    category = s.category,
                    tag = s.filterTag,
                    q = s.query.ifBlank { null },
                    source = s.filterSource,
                    from = s.filterTime?.fromParam(),
                )
                _ui.value = _ui.value.copy(notes = page.notes, loading = false, cursor = page.cursor)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
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

    /** 推送偏好（与 Web Push 共用，存后端） */
    suspend fun getPushPreferences() = repo.getPreferences()

    suspend fun updatePushPreferences(dailyReviewPush: Boolean? = null, todoReminderPush: Boolean? = null) =
        repo.updatePreferences(dailyReviewPush, todoReminderPush)

    /** 永久注销账号：删除云端全部数据并清本机登录状态 */
    suspend fun deleteAccount() = repo.deleteAccount()

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

    /** 手动标记/取消敏感：乐观更新，失败回滚 */
    fun toggleSensitive(note: Note) {
        val target = !note.isSensitive
        val optimistic = _ui.value.notes.map { if (it.id == note.id) it.copy(isSensitive = target) else it }
        _ui.value = _ui.value.copy(notes = optimistic)
        viewModelScope.launch {
            try {
                val updated = repo.setSensitive(note.id, target)
                if (updated != null) {
                    _ui.value = _ui.value.copy(
                        notes = _ui.value.notes.map { if (it.id == note.id) updated else it },
                        toast = if (target) "已标记敏感" else "已取消敏感",
                    )
                }
            } catch (e: Exception) {
                val rolledBack = _ui.value.notes.map { if (it.id == note.id) note else it }
                _ui.value = _ui.value.copy(notes = rolledBack, toast = e.message ?: "操作失败")
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

    /** 从文件选择器上传文档：POST /api/ingest/media type=file */
    fun uploadFile(bytes: ByteArray, mime: String, fileName: String) {
        if (bytes.size > 10 * 1024 * 1024) {
            _ui.value = _ui.value.copy(toast = "文件过大：最多 10MB")
            return
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            try {
                repo.sendFile(bytes, mime, fileName)
                _ui.value = _ui.value.copy(sending = false, toast = "已上传，AI 正在提取文件内容")
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(sending = false, toast = e.message ?: "文件上传失败")
            }
        }
    }

    /** 下载文件笔记原件到系统下载目录 */
    fun downloadFile(note: Note) {
        val fileName = note.meta?.fileName ?: "suinian-file"
        _ui.value = _ui.value.copy(toast = "开始下载…")
        viewModelScope.launch {
            try {
                val (bytes, mime) = repo.downloadNoteFile(note.id)
                saveToDownloads(fileName, mime, bytes)
                _ui.value = _ui.value.copy(toast = "已保存到下载：$fileName")
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(toast = e.message ?: "下载失败")
            }
        }
    }

    private fun saveToDownloads(fileName: String, mime: String, bytes: ByteArray) {
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
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("无法写入下载文件")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } else {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: throw IllegalStateException("存储不可用")
            java.io.File(dir, fileName).writeBytes(bytes)
        }
    }

    fun deleteNote(note: Note) {
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

    /** 下载全量备份 zip 到系统下载目录，返回文件名。includeSensitive=true 时敏感笔记含明文 */
    suspend fun downloadBackupToDownloads(includeSensitive: Boolean = false): String {
        val (bytes, fileName) = repo.downloadBackup(includeSensitive)
        saveToDownloads(fileName, "application/zip", bytes)
        return fileName
    }

    /** 从备份 zip 恢复，返回恢复统计 */
    suspend fun restoreFromBackup(bytes: ByteArray, fileName: String): RestoreStats {
        val stats = repo.restoreBackup(bytes, fileName)
        refresh()
        return stats
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
        _ui.value = _ui.value.copy(editingNote = note)
    }

    fun closeEditor() {
        _ui.value = _ui.value.copy(editingNote = null)
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
                )
                _ui.value = _ui.value.copy(
                    savingEdit = false,
                    editingNote = null,
                    notes = if (updated != null) {
                        _ui.value.notes.map { if (it.id == note.id) updated else it }
                    } else _ui.value.notes,
                    toast = "已保存",
                )
                if (updated == null) refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(savingEdit = false, toast = e.message ?: "保存失败")
            }
        }
    }
}
