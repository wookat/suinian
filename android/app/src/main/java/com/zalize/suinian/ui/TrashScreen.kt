package com.zalize.suinian.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.RestoreFromTrash
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.NoteCard
import com.zalize.suinian.ui.components.parseInstantLenient
import kotlinx.coroutines.launch
import java.time.Instant

/** 剩余保留时间文案：天数向上取整，刚删除即显示完整保留天数；不足一天按小时（对齐 Web remainingLabel） */
fun trashRemainingLabel(purgeAt: String?, now: Instant = Instant.now()): String {
    if (purgeAt.isNullOrBlank()) return ""
    val t = parseInstantLenient(purgeAt) ?: return ""
    val ms = t.toEpochMilli() - now.toEpochMilli()
    if (ms <= 0) return "即将清理"
    val days = (ms + 86_399_999) / 86_400_000
    if (days > 1) return "剩 $days 天"
    val hours = ms / 3_600_000
    return if (hours >= 1) "剩 $hours 小时" else "剩不足 1 小时"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(
    vm: NotesViewModel,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var notes by remember { mutableStateOf<List<Note>>(emptyList()) }
    var retentionDays by remember { mutableStateOf(30) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmEmpty by remember { mutableStateOf(false) }
    var confirmPurge by remember { mutableStateOf<Note?>(null) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        loading = true
        error = null
        try {
            val res = vm.listTrash()
            notes = res.notes
            retentionDays = res.retentionDays
        } catch (e: Exception) {
            error = e.message ?: "加载失败，请稍后重试"
        } finally {
            loading = false
        }
    }

    if (confirmEmpty) {
        AlertDialog(
            onDismissRequest = { confirmEmpty = false },
            title = { Text("清空回收站？") },
            text = { Text("将彻底删除全部 ${notes.size} 条笔记，不可恢复") },
            confirmButton = {
                TextButton(onClick = {
                    confirmEmpty = false
                    scope.launch {
                        try {
                            val purged = vm.emptyTrash()
                            notes = emptyList()
                            snackbarHostState.showSnackbar("已清空回收站（彻底删除 $purged 条）")
                        } catch (e: Exception) {
                            snackbarHostState.showSnackbar(e.message ?: "清空失败")
                        }
                    }
                }) { Text("清空", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmEmpty = false }) { Text("取消") } },
        )
    }

    confirmPurge?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmPurge = null },
            title = { Text("彻底删除这条笔记？") },
            text = { Text("彻底删除后不可恢复") },
            confirmButton = {
                TextButton(onClick = {
                    confirmPurge = null
                    scope.launch {
                        try {
                            vm.purgeNotes(listOf(target.id))
                            notes = notes.filter { it.id != target.id }
                            snackbarHostState.showSnackbar("已彻底删除 1 条笔记")
                        } catch (e: Exception) {
                            snackbarHostState.showSnackbar(e.message ?: "彻底删除失败")
                        }
                    }
                }) { Text("彻底删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmPurge = null }) { Text("取消") } },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("最近删除") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
                actions = {
                    if (notes.isNotEmpty()) {
                        IconButton(onClick = { confirmEmpty = true }) {
                            Icon(Icons.Outlined.DeleteForever, contentDescription = "清空回收站")
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        when {
            loading -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            error != null -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(error ?: "", color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { reloadKey++ }) { Text("重试") }
            }

            notes.isEmpty() -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "回收站是空的\n删除的笔记会在这里保留 $retentionDays 天",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            else -> LazyColumn(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item {
                    Text(
                        "删除的笔记保留 $retentionDays 天，到期自动彻底清理",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(notes, key = { it.id }) { note ->
                    Column {
                        NoteCard(note = note)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 4.dp),
                        ) {
                            Text(
                                trashRemainingLabel(note.purgeAt),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f),
                            )
                            OutlinedButton(onClick = {
                                scope.launch {
                                    try {
                                        val restored = vm.restoreTrashNotes(listOf(note.id))
                                        if (restored > 0) {
                                            notes = notes.filter { it.id != note.id }
                                            snackbarHostState.showSnackbar("已恢复 1 条笔记")
                                        } else {
                                            snackbarHostState.showSnackbar("恢复失败：笔记可能已被清理")
                                        }
                                    } catch (e: Exception) {
                                        snackbarHostState.showSnackbar(e.message ?: "恢复失败")
                                    }
                                }
                            }) {
                                Icon(Icons.Outlined.RestoreFromTrash, contentDescription = null)
                                Spacer(Modifier.width(4.dp))
                                Text("恢复")
                            }
                            Spacer(Modifier.width(8.dp))
                            OutlinedButton(onClick = { confirmPurge = note }) {
                                Icon(
                                    Icons.Outlined.DeleteForever,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error,
                                )
                                Spacer(Modifier.width(4.dp))
                                Text("彻底删除", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }
}
