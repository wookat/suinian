package com.zalize.suinian.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Search
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.NotesViewLimits
import com.zalize.suinian.ui.components.NoteCard

private val categories = listOf(
    null to "全部",
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
)

@Composable
fun HomeScreen(vm: NotesViewModel, modifier: Modifier = Modifier, focusQuickNoteSignal: Int = 0) {
    val ui by vm.ui.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    var draft by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(focusQuickNoteSignal) {
        if (focusQuickNoteSignal > 0) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    Column(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        // 速记框
        val overLimit = draft.length > NotesViewLimits.MAX_CONTENT_CHARS
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            placeholder = { Text("现在的想法是……") },
            shape = RoundedCornerShape(16.dp),
            maxLines = 4,
            isError = overLimit,
            supportingText = if (overLimit) {
                { Text("内容过长：最多 ${NotesViewLimits.MAX_CONTENT_CHARS} 字符，当前 ${draft.length} 字符") }
            } else null,
            trailingIcon = {
                IconButton(
                    onClick = {
                        vm.quickSend(draft)
                        draft = ""
                    },
                    enabled = draft.isNotBlank() && !overLimit && !ui.sending,
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "记下")
                }
            },
        )

        Spacer(Modifier.height(8.dp))

        // 搜索框 / 问答框
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = if (ui.askMode) ui.askInput else ui.query,
                onValueChange = { if (ui.askMode) vm.setAskInput(it) else vm.setQuery(it) },
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (ui.askMode) "问问你的笔记，例如：我之前想过的那个点子…" else "搜索碎念…") },
                shape = RoundedCornerShape(16.dp),
                singleLine = true,
                leadingIcon = {
                    Icon(
                        if (ui.askMode) Icons.Outlined.AutoAwesome else Icons.Outlined.Search,
                        contentDescription = null,
                    )
                },
                trailingIcon = {
                    IconButton(onClick = { if (ui.askMode) vm.ask() else vm.search() }) {
                        Icon(
                            Icons.AutoMirrored.Outlined.Send,
                            contentDescription = if (ui.askMode) "提问" else "搜索",
                        )
                    }
                },
            )
            Spacer(Modifier.width(8.dp))
            FilterChip(
                selected = ui.askMode,
                onClick = { vm.toggleAskMode() },
                label = { Text("问答") },
                leadingIcon = { Icon(Icons.Outlined.AutoAwesome, contentDescription = null) },
            )
        }

        // 问答结果卡
        if (ui.askMode && (ui.asking || ui.askAnswer != null || ui.askError != null)) {
            Spacer(Modifier.height(8.dp))
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f)
                ),
                elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
            ) {
                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                    when {
                        ui.asking -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.width(18.dp).height(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("正在思考…", style = MaterialTheme.typography.bodyMedium)
                        }
                        ui.askError != null -> Text(
                            ui.askError!!,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                        else -> {
                            Row {
                                Text(
                                    ui.askAnswer.orEmpty(),
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.weight(1f),
                                )
                                IconButton(onClick = { vm.clearAskResult() }) {
                                    Icon(Icons.Outlined.Close, contentDescription = "关闭回答")
                                }
                            }
                            if (ui.askReferences.isNotEmpty()) {
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    "引用笔记（${ui.askReferences.size}）",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                ui.askReferences.forEach { note ->
                                    Spacer(Modifier.height(6.dp))
                                    NoteCard(note)
                                }
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))

        // 分类筛选
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            categories.forEach { (value, label) ->
                FilterChip(
                    selected = ui.category == value,
                    onClick = { vm.setCategory(value) },
                    label = { Text(label) },
                )
            }
        }

        if (pending > 0) {
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.CloudOff,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "$pending 条待重试",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.secondary,
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        when {
            ui.loading && ui.notes.isEmpty() -> {
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator() }
            }
            ui.error != null -> {
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        ui.error ?: "加载失败",
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    AssistChip(onClick = { vm.refresh() }, label = { Text("重试") })
                }
            }
            ui.notes.isEmpty() -> {
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("还没有碎念，记一条吧", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            else -> {
                val listState = rememberLazyListState()
                LaunchedEffect(ui.notes.firstOrNull()?.id) {
                    listState.scrollToItem(0)
                }
                // 接近列表尾部时自动加载下一页
                val shouldLoadMore by remember {
                    derivedStateOf {
                        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
                        lastVisible >= listState.layoutInfo.totalItemsCount - 3
                    }
                }
                LaunchedEffect(listState) {
                    snapshotFlow { shouldLoadMore }.collect { if (it) vm.loadMore() }
                }
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(ui.notes, key = { it.id }) { note ->
                        NoteCard(note, onToggleTodo = { vm.toggleTodo(it) })
                    }
                    if (ui.loadingMore) {
                        item {
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                horizontalArrangement = Arrangement.Center,
                            ) { CircularProgressIndicator(Modifier.width(24.dp).height(24.dp)) }
                        }
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}
