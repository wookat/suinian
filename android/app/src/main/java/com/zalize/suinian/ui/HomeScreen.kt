package com.zalize.suinian.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val categories = listOf(
    null to "全部",
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
)

internal fun categoryLabel(category: String?): String {
    if (category == null) return "分拣中"
    return categories.firstOrNull { it.first == category }?.second ?: category
}

@Composable
fun HomeScreen(vm: NotesViewModel, modifier: Modifier = Modifier, focusQuickNoteSignal: Int = 0) {
    val ui by vm.ui.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    var draft by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }

    LaunchedEffect(focusQuickNoteSignal) {
        if (focusQuickNoteSignal > 0) focusRequester.requestFocus()
    }

    Column(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        // 速记框
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            placeholder = { Text("现在的想法是……") },
            shape = RoundedCornerShape(16.dp),
            maxLines = 4,
            trailingIcon = {
                IconButton(
                    onClick = {
                        vm.quickSend(draft)
                        draft = ""
                    },
                    enabled = draft.isNotBlank() && !ui.sending,
                ) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "记下")
                }
            },
        )

        Spacer(Modifier.height(8.dp))

        // 搜索框
        OutlinedTextField(
            value = ui.query,
            onValueChange = { vm.setQuery(it) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("搜索碎念…") },
            shape = RoundedCornerShape(16.dp),
            singleLine = true,
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                IconButton(onClick = { vm.search() }) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "搜索")
                }
            },
        )

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
                    Text("加载失败：${ui.error}", color = MaterialTheme.colorScheme.error)
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
                        NoteCard(note)
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

@Composable
private fun NoteCard(note: Note) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryBadge(note.category)
                Spacer(Modifier.width(8.dp))
                Text(
                    formatTime(note.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            if (note.isSensitive) {
                var revealed by rememberSaveable(note.id) { mutableStateOf(false) }
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { revealed = !revealed },
                ) {
                    Icon(
                        if (revealed) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
                        contentDescription = if (revealed) "隐藏敏感内容" else "显示敏感内容",
                        tint = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (revealed) note.content else "••••••••",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                Text(note.content, style = MaterialTheme.typography.bodyMedium)
            }

            // 待办截止时间
            if (note.category == "todo" && !note.todoDue.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Outlined.Event,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.tertiary,
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        "截止 ${formatDue(note.todoDue)}" + if (note.todoDone == true) " · 已完成" else "",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }

            // 链接卡片
            if (note.url != null) {
                Spacer(Modifier.height(8.dp))
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Column(Modifier.fillMaxWidth().padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Outlined.Link,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                note.urlTitle ?: note.url,
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (note.urlSummary != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                note.urlSummary,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }

            if (note.tags.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    note.tags.take(5).forEach { tag ->
                        Text(
                            "#$tag",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CategoryBadge(category: String?) {
    Text(
        categoryLabel(category),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

private val timeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

private fun formatTime(iso: String): String = try {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(timeFormatter)
} catch (_: Exception) {
    iso.take(16).replace("T", " ")
}

private fun formatDue(iso: String): String = try {
    Instant.parse(iso).atZone(ZoneId.systemDefault()).format(timeFormatter)
} catch (_: Exception) {
    iso.take(16).replace("T", " ")
}
