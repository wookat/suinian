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

/** 「你能做什么」帮助文案（对齐 Web HELP_TEXT） */
val ASK_HELP_TEXT = listOf(
    "碎念能帮你：",
    "• 随手记：首页速记框/分享面板/小组件丢文字、链接、文件，AI 自动分拣为想法/待办/收藏/资料/收支",
    "• 问答：在这里直接提问，如「我最近在想什么」，支持多轮追问，回答中 [n] 可点击查看引用笔记",
    "• 快捷指令（微信 & 首页速记框）：?问题 提问；!内容 强制原样保存不分拣；#标签 内容 手动打标",
    "• 回顾：每天推送往日笔记回顾；每周一生成周报，每月 1 日生成月报；同主题想法自动串成线索",
    "• 数据：设置页可导入 flomo/Cubox、导出 JSON/Markdown，也可用 API 直接写入",
).joinToString("\n")

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

    /** 引用卡是敏感 / 受守占位时，点开按登录态取回原文（GET /api/notes/:id） */
    suspend fun fetchNote(noteId: String): Note? = repo.getNote(noteId)

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

    /** 在对话中插入「你能做什么」帮助消息（不请求后端） */
    fun showHelp() {
        val updated = _ui.value.messages +
            AskChatMessage(id = UUID.randomUUID().toString(), role = "assistant", content = ASK_HELP_TEXT)
        _ui.value = _ui.value.copy(messages = updated)
        persist(updated)
    }

    fun send() = ask(_ui.value.input.trim())

    /** 直接提问（首页速记框 ?问题 内联指令路由到这里） */
    fun ask(question: String) {
        val q = question.trim()
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
