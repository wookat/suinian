package com.zalize.suinian.ui

import android.app.Application
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.GraphEntity
import com.zalize.suinian.data.Thread
import com.zalize.suinian.data.ThreadDetail
import com.zalize.suinian.ui.components.NoteCard
import com.zalize.suinian.ui.components.formatRelativeTime
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** 实体类型中文标签（对齐 Web ENTITY_TYPE_LABEL） */
fun entityTypeLabel(type: String): String = when (type) {
    "person" -> "人物"
    "product" -> "产品"
    "project" -> "项目"
    "org" -> "组织"
    "place" -> "地点"
    "concept" -> "概念"
    else -> "其他"
}

data class ThreadsUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val threads: List<Thread> = emptyList(),
    val detailLoading: Boolean = false,
    val detailError: String? = null,
    val detail: ThreadDetail? = null,
)

class ThreadsViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as SuinianApp).repository

    private val _ui = MutableStateFlow(ThreadsUiState())
    val ui: StateFlow<ThreadsUiState> = _ui

    init {
        refresh()
    }

    fun refresh() {
        _ui.value = _ui.value.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val threads = repo.listThreads()
                _ui.value = _ui.value.copy(loading = false, threads = threads)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    fun loadDetail(id: String) {
        _ui.value = _ui.value.copy(detailLoading = true, detailError = null, detail = null)
        viewModelScope.launch {
            try {
                val detail = repo.getThread(id)
                _ui.value = _ui.value.copy(detailLoading = false, detail = detail)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(detailLoading = false, detailError = e.message ?: "加载失败")
            }
        }
    }
}

@Composable
fun ThreadsScreen(
    modifier: Modifier = Modifier,
    vm: ThreadsViewModel = viewModel(),
    onOpenThread: (String) -> Unit,
) {
    val ui by vm.ui.collectAsState()

    when {
        ui.loading && ui.threads.isEmpty() -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) { CircularProgressIndicator() }
        ui.error != null -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(ui.error ?: "加载失败", color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(8.dp))
            AssistChip(onClick = { vm.refresh() }, label = { Text("重试") })
        }
        ui.threads.isEmpty() -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "还没有思考线索\n同一主题的碎念积累后会自动串成线索",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        else -> LazyColumn(
            modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(ui.threads, key = { it.id }) { thread ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onOpenThread(thread.id) },
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    ),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            thread.title,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!thread.summary.isNullOrBlank()) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                thread.summary,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "${thread.noteCount} 条碎念",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                formatRelativeTime(thread.updatedAt),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadDetailScreen(
    threadId: String,
    vm: ThreadsViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val ui by vm.ui.collectAsState()

    LaunchedEffect(threadId) { vm.loadDetail(threadId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        ui.detail?.thread?.title ?: "线索",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        when {
            ui.detailLoading -> Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
            ui.detailError != null -> Column(
                Modifier.fillMaxSize().padding(padding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(ui.detailError ?: "加载失败", color = MaterialTheme.colorScheme.error)
                Spacer(Modifier.height(8.dp))
                AssistChip(onClick = { vm.loadDetail(threadId) }, label = { Text("重试") })
            }
            else -> {
                val detail = ui.detail ?: return@Scaffold
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    if (!detail.thread.summary.isNullOrBlank()) {
                        item {
                            Card(
                                shape = RoundedCornerShape(16.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f)
                                ),
                                elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                            ) {
                                Text(
                                    detail.thread.summary,
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.padding(12.dp),
                                )
                            }
                        }
                    }
                    val graph = detail.graph
                    if (graph != null && graph.entities.isNotEmpty()) {
                        item {
                            Text(
                                "实体脉络（${graph.entities.size}）",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        item {
                            Card(
                                shape = RoundedCornerShape(16.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                                ),
                                elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                            ) {
                                Column(Modifier.fillMaxWidth().padding(12.dp)) {
                                    graph.entities.forEach { entity ->
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier.padding(vertical = 3.dp),
                                        ) {
                                            Text(
                                                entityTypeLabel(entity.type),
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                                modifier = Modifier
                                                    .clip(RoundedCornerShape(6.dp))
                                                    .background(MaterialTheme.colorScheme.secondaryContainer)
                                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                                            )
                                            Spacer(Modifier.width(8.dp))
                                            Text(
                                                entity.name,
                                                style = MaterialTheme.typography.bodyMedium,
                                                fontWeight = FontWeight.Medium,
                                                modifier = Modifier.weight(1f),
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                            if (entity.noteCount > 0) {
                                                Text(
                                                    "${entity.noteCount} 条",
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if (graph.relations.isNotEmpty()) {
                            item {
                                Text(
                                    "关系（${graph.relations.size}）",
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                            item {
                                Card(
                                    shape = RoundedCornerShape(16.dp),
                                    colors = CardDefaults.cardColors(
                                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                                    ),
                                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                                ) {
                                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                                        val nameById = graph.entities.associateBy(GraphEntity::id)
                                        graph.relations.forEach { rel ->
                                            val src = nameById[rel.src]?.name ?: rel.src
                                            val dst = nameById[rel.dst]?.name ?: rel.dst
                                            Text(
                                                "$src — ${rel.relationLabel.ifBlank { "关联" }} → $dst",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                modifier = Modifier.padding(vertical = 3.dp),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    item {
                        Text(
                            "碎片时间线（${detail.notes.size}）",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    items(detail.notes, key = { it.id }) { note ->
                        NoteCard(note)
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
        }
    }
}
