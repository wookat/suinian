package com.zalize.suinian.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.AskHistoryMessage
import com.zalize.suinian.data.Note
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.util.UUID

/** 一条问答消息（本地持久化） */
@Serializable
data class AskChatMessage(
    val id: String,
    val role: String, // user|assistant
    val content: String,
    /** 引用笔记，index 与回答中的 [n] 对应 */
    val refs: List<AskChatRef> = emptyList(),
    @SerialName("is_error") val isError: Boolean = false,
)

@Serializable
data class AskChatRef(
    val index: Int,
    val note: Note,
)

data class AskUiState(
    val messages: List<AskChatMessage> = emptyList(),
    val input: String = "",
    val asking: Boolean = false,
)

private const val HISTORY_MAX_MESSAGES = 6 // 最近 3 轮，对齐后端与 Web
private const val SAVED_MAX_MESSAGES = 50

class AskViewModel(app: Application) : AndroidViewModel(app) {

    private val suinian = app as SuinianApp
    private val repo = suinian.repository
    private val settingsRepo = suinian.settings

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }
    private val listSerializer = ListSerializer(AskChatMessage.serializer())

    private val _ui = MutableStateFlow(AskUiState())
    val ui: StateFlow<AskUiState> = _ui

    init {
        viewModelScope.launch {
            val raw = settingsRepo.askChatJson.first()
            if (raw.isNotBlank()) {
                val restored = try {
                    json.decodeFromString(listSerializer, raw)
                } catch (_: Exception) {
                    emptyList()
                }
                _ui.value = _ui.value.copy(messages = restored)
            }
        }
    }

    fun setInput(v: String) {
        _ui.value = _ui.value.copy(input = v)
    }

    fun clearChat() {
        _ui.value = _ui.value.copy(messages = emptyList())
        viewModelScope.launch { settingsRepo.setAskChatJson("") }
    }

    private fun persist(messages: List<AskChatMessage>) {
        viewModelScope.launch {
            try {
                settingsRepo.setAskChatJson(json.encodeToString(listSerializer, messages.takeLast(SAVED_MAX_MESSAGES)))
            } catch (_: Exception) {
                // 持久化失败不影响内存态会话
            }
        }
    }

    fun send() {
        val q = _ui.value.input.trim()
        if (q.isEmpty() || _ui.value.asking) return
        val history = _ui.value.messages
            .filter { !it.isError }
            .takeLast(HISTORY_MAX_MESSAGES)
            .map { AskHistoryMessage(role = it.role, content = it.content) }
        val userMsg = AskChatMessage(id = UUID.randomUUID().toString(), role = "user", content = q)
        val afterUser = _ui.value.messages + userMsg
        _ui.value = _ui.value.copy(messages = afterUser, input = "", asking = true)
        persist(afterUser)
        viewModelScope.launch {
            val reply = try {
                val res = repo.ask(q, history)
                val refs = res.references.mapNotNull { r ->
                    res.notes.firstOrNull { it.id == r.noteId }?.let { AskChatRef(index = r.index, note = it) }
                }
                AskChatMessage(id = UUID.randomUUID().toString(), role = "assistant", content = res.answer, refs = refs)
            } catch (e: Exception) {
                AskChatMessage(
                    id = UUID.randomUUID().toString(),
                    role = "assistant",
                    content = e.message ?: "提问失败，请稍后重试",
                    isError = true,
                )
            }
            val updated = _ui.value.messages + reply
            _ui.value = _ui.value.copy(messages = updated, asking = false)
            persist(updated)
        }
    }
}
