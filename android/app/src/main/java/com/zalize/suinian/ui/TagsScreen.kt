package com.zalize.suinian.ui

import android.app.Application
import android.widget.Toast
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.TagCount
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class TagsUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val tags: List<TagCount> = emptyList(),
    val busy: Boolean = false,
    val toast: String? = null,
    /** bumped on successful rename/delete so the host can refresh dependent screens */
    val changes: Int = 0,
)

class TagsViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as SuinianApp).repository

    private val _ui = MutableStateFlow(TagsUiState())
    val ui: StateFlow<TagsUiState> = _ui

    init {
        refresh()
    }

    fun refresh() {
        _ui.value = _ui.value.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                _ui.value = _ui.value.copy(loading = false, tags = repo.listTags())
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    fun rename(from: String, to: String) {
        val target = to.trim().removePrefix("#")
        if (target.isEmpty() || target == from) return
        val merging = _ui.value.tags.any { it.tag == target }
        _ui.value = _ui.value.copy(busy = true)
        viewModelScope.launch {
            try {
                repo.renameTag(from, target)
                _ui.value = _ui.value.copy(
                    busy = false,
                    toast = if (merging) "已合并到 #$target" else "已重命名为 #$target",
                    changes = _ui.value.changes + 1,
                )
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(busy = false, toast = e.message ?: "重命名失败")
            }
        }
    }

    fun delete(tag: String) {
        _ui.value = _ui.value.copy(busy = true)
        viewModelScope.launch {
            try {
                repo.deleteTag(tag)
                _ui.value = _ui.value.copy(busy = false, toast = "已删除标签 #$tag", changes = _ui.value.changes + 1)
                refresh()
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(busy = false, toast = e.message ?: "删除失败")
            }
        }
    }

    fun consumeToast() {
        _ui.value = _ui.value.copy(toast = null)
    }
}

/** 标签管理页：列表（含使用次数）/重命名/合并/删除（对齐 Web R36） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TagsScreen(onBack: () -> Unit, onTagsChanged: () -> Unit = {}, vm: TagsViewModel = viewModel()) {
    val ui by vm.ui.collectAsState()
    val context = LocalContext.current
    var renaming by remember { mutableStateOf<String?>(null) }
    var renameValue by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<TagCount?>(null) }

    LaunchedEffect(ui.toast) {
        ui.toast?.let {
            Toast.makeText(context, it, Toast.LENGTH_SHORT).show()
            vm.consumeToast()
        }
    }

    LaunchedEffect(ui.changes) {
        if (ui.changes > 0) onTagsChanged()
    }

    renaming?.let { from ->
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("重命名 #$from") },
            text = {
                Column {
                    Text(
                        "全局替换所有笔记上的该标签；改名到已有标签即合并",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = renameValue,
                        onValueChange = { renameValue = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("新标签名") },
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        vm.rename(from, renameValue)
                        renaming = null
                    },
                    enabled = !ui.busy && renameValue.trim().removePrefix("#").isNotEmpty(),
                ) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("取消") } },
        )
    }

    deleting?.let { tc ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("删除标签 #${tc.tag}？") },
            text = { Text("将从 ${tc.count} 条笔记上移除该标签，笔记本身不会被删除") },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(tc.tag)
                    deleting = null
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("标签管理") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        when {
            ui.loading && ui.tags.isEmpty() -> Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
            ui.error != null -> Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(ui.error ?: "加载失败", color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
                AssistChip(onClick = { vm.refresh() }, label = { Text("重试") })
            }
            ui.tags.isEmpty() -> Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    "还没有标签\nAI 分拣或手动编辑后会出现在这里",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            ) {
                item {
                    Text(
                        "重命名会全局替换；改名到已有标签即合并；删除仅移除标签，不删笔记",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
                items(ui.tags, key = { it.tag }) { tc ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "#${tc.tag}",
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                "${tc.count} 条",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(
                            onClick = {
                                renaming = tc.tag
                                renameValue = tc.tag
                            },
                            enabled = !ui.busy,
                        ) {
                            Icon(Icons.Outlined.Edit, contentDescription = "重命名/合并 ${tc.tag}")
                        }
                        Spacer(Modifier.width(4.dp))
                        IconButton(onClick = { deleting = tc }, enabled = !ui.busy) {
                            Icon(
                                Icons.Outlined.Delete,
                                contentDescription = "删除标签 ${tc.tag}",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    HorizontalDivider()
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}
