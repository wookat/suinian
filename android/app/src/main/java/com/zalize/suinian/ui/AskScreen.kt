package com.zalize.suinian.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.NoteCard

private val REF_REGEX = Regex("[\\[［](\\d{1,2})[\\]］]")

/** 问答 tab：多轮聊天气泡 + 引用可点开笔记 + 清空会话 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AskScreen(vm: AskViewModel, modifier: Modifier = Modifier) {
    val ui by vm.ui.collectAsState()
    var refNote by remember { mutableStateOf<Note?>(null) }
    var confirmClear by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    LaunchedEffect(ui.messages.size, ui.asking) {
        val count = ui.messages.size + if (ui.asking) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("清空对话？") },
            text = { Text("将删除本机保存的问答记录，笔记不受影响") },
            confirmButton = {
                TextButton(onClick = {
                    confirmClear = false
                    vm.clearChat()
                }) { Text("清空") }
            },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("取消") } },
        )
    }

    refNote?.let { note ->
        ModalBottomSheet(onDismissRequest = { refNote = null }) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
                Text(
                    "引用笔记",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(8.dp))
                NoteCard(note)
            }
        }
    }

    Column(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(
                "问问你的笔记",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { vm.showHelp() }) { Text("你能做什么？") }
            if (ui.messages.isNotEmpty()) {
                IconButton(onClick = { confirmClear = true }) {
                    Icon(
                        Icons.Outlined.DeleteSweep,
                        contentDescription = "清空对话",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (ui.messages.isEmpty() && !ui.asking) {
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(top = 80.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Outlined.AutoAwesome,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(36.dp),
                        )
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "问问你的笔记，例如：\n我之前想过的那个点子是什么？",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { vm.showHelp() }) { Text("你能做什么？") }
                    }
                }
            }
            items(ui.messages, key = { it.id }) { msg ->
                ChatBubble(msg, onRefClick = { refNote = it })
            }
            if (ui.asking) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("正在思考…", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            item { Spacer(Modifier.height(4.dp)) }
        }

        OutlinedTextField(
            value = ui.input,
            onValueChange = { vm.setInput(it) },
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            placeholder = { Text("继续追问，或换个问题…") },
            shape = RoundedCornerShape(16.dp),
            maxLines = 3,
            trailingIcon = {
                IconButton(
                    onClick = { vm.send() },
                    enabled = ui.input.isNotBlank() && !ui.asking,
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "提问")
                }
            },
        )
    }
}

@Composable
private fun ChatBubble(msg: AskChatMessage, onRefClick: (Note) -> Unit) {
    val isUser = msg.role == "user"
    Box(Modifier.fillMaxWidth(), contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier
                .widthIn(max = 320.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isUser) 16.dp else 4.dp,
                        bottomEnd = if (isUser) 4.dp else 16.dp,
                    )
                )
                .background(
                    when {
                        isUser -> MaterialTheme.colorScheme.primaryContainer
                        msg.isError -> MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.6f)
                        else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)
                    }
                )
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            if (isUser || msg.refs.isEmpty()) {
                Text(
                    msg.content,
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        isUser -> MaterialTheme.colorScheme.onPrimaryContainer
                        msg.isError -> MaterialTheme.colorScheme.onErrorContainer
                        else -> MaterialTheme.colorScheme.onSurface
                    },
                )
            } else {
                AnswerWithRefs(msg, onRefClick)
            }
            if (msg.refs.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "引用笔记（${msg.refs.size}）· 点 [n] 查看",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** 回答文本：[n] 渲染为可点击引用，点击弹出对应笔记 */
@Composable
private fun AnswerWithRefs(msg: AskChatMessage, onRefClick: (Note) -> Unit) {
    val refByIndex = remember(msg.id) { msg.refs.associateBy { it.index } }
    val primary = MaterialTheme.colorScheme.primary
    val annotated = remember(msg.id, primary) {
        buildAnnotatedString {
            var last = 0
            for (m in REF_REGEX.findAll(msg.content)) {
                val n = m.groupValues[1].toIntOrNull()
                val ref = n?.let { refByIndex[it] }
                append(msg.content.substring(last, m.range.first))
                if (ref != null) {
                    withLink(
                        LinkAnnotation.Clickable(tag = "ref-${ref.index}") { onRefClick(ref.note) }
                    ) {
                        withStyle(SpanStyle(color = primary, fontWeight = FontWeight.SemiBold)) {
                            append("[${ref.index}]")
                        }
                    }
                } else {
                    append(m.value)
                }
                last = m.range.last + 1
            }
            append(msg.content.substring(last))
        }
    }
    Text(annotated, style = MaterialTheme.typography.bodyMedium)
}
