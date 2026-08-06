package com.zalize.suinian.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.AppSettings
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.Note
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
                _ui.value = _ui.value.copy(notes = page.notes, loading = false)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
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

    fun quickSend(text: String) {
        val content = text.trim()
        if (content.isEmpty()) return
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
