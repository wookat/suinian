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
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NotesViewLimits
import com.zalize.suinian.data.SendResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class NotesUiState(
    val notes: List<Note> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val category: String? = null,
    val query: String = "",
    val sending: Boolean = false,
    val toast: String? = null,
    val cursor: String? = null,
    val loadingMore: Boolean = false,
    val retryingLinkIds: Set<String> = emptySet(),
)

class NotesViewModel(app: Application) : AndroidViewModel(app) {

    private val suinian = app as SuinianApp
    private val repo = suinian.repository
    val settingsRepo = suinian.settings

    private val _ui = MutableStateFlow(NotesUiState())
    val ui: StateFlow<NotesUiState> = _ui

    val settings: StateFlow<AppSettings> = settingsRepo.settings
        .stateIn(viewModelScope, SharingStarted.Eagerly, AppSettings())

    val pendingCount: StateFlow<Int> = repo.pendingCount
        .stateIn(viewModelScope, SharingStarted.Eagerly, 0)

    init {
        refresh()
    }

    fun refresh() {
        val s = _ui.value
        _ui.value = s.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val page = repo.list(category = s.category, tag = null, q = s.query.ifBlank { null })
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
                    tag = null,
                    q = s.query.ifBlank { null },
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

    /** 设置页轮换 API token（成功后新 token 已保存到本机） */
    suspend fun rotateApiToken(): String = repo.rotateToken()

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
                _ui.value = _ui.value.copy(toast = "已删除")
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(notes = prev, toast = e.message ?: "删除失败")
            }
        }
    }

    fun quickSend(text: String) {
        val content = text.trim()
        if (content.isEmpty()) return
        if (content.length > NotesViewLimits.MAX_CONTENT_CHARS) {
            _ui.value = _ui.value.copy(
                toast = "内容过长：最多 ${NotesViewLimits.MAX_CONTENT_CHARS} 字符，当前 ${content.length} 字符"
            )
            return
        }
        _ui.value = _ui.value.copy(sending = true)
        viewModelScope.launch {
            val isLink = content.startsWith("http://") || content.startsWith("https://")
            val result = repo.send(
                CreateNoteRequest(
                    source = "android",
                    rawType = if (isLink) "link" else "text",
                    content = content,
                    url = if (isLink) content else null,
                )
            )
            val toast = when (result) {
                is SendResult.Sent -> "已记下"
                SendResult.Queued -> "已离线暂存，稍后自动重试"
            }
            _ui.value = _ui.value.copy(sending = false, toast = toast)
            refresh()
        }
    }

    fun consumeToast() {
        _ui.value = _ui.value.copy(toast = null)
    }
}
