package com.zalize.suinian.ui

import android.app.Application
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
    // 问答模式
    val askMode: Boolean = false,
    val askInput: String = "",
    val asking: Boolean = false,
    val askAnswer: String? = null,
    val askError: String? = null,
    val askReferences: List<Note> = emptyList(),
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

    fun toggleAskMode() {
        val s = _ui.value
        _ui.value = s.copy(askMode = !s.askMode, askAnswer = null, askError = null, askReferences = emptyList())
    }

    fun setAskInput(v: String) {
        _ui.value = _ui.value.copy(askInput = v)
    }

    fun clearAskResult() {
        _ui.value = _ui.value.copy(askAnswer = null, askError = null, askReferences = emptyList())
    }

    fun ask() {
        val question = _ui.value.askInput.trim()
        if (question.isEmpty() || _ui.value.asking) return
        _ui.value = _ui.value.copy(asking = true, askAnswer = null, askError = null, askReferences = emptyList())
        viewModelScope.launch {
            try {
                val res = repo.ask(question)
                // 引用只有 id：从当前列表 + 最近一页里尽量匹配出笔记内容
                val pool = (_ui.value.notes + runCatching { repo.list(null, null, null).notes }.getOrDefault(emptyList()))
                    .distinctBy { it.id }
                val refNotes = res.references.mapNotNull { ref -> pool.firstOrNull { it.id == ref.noteId } }.take(5)
                _ui.value = _ui.value.copy(asking = false, askAnswer = res.answer, askReferences = refNotes)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(asking = false, askError = e.message ?: "提问失败，请稍后重试")
            }
        }
    }

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
