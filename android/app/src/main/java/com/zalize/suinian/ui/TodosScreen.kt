package com.zalize.suinian.ui

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.Note
import com.zalize.suinian.ui.components.NoteCard
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId

enum class DueGroup(val label: String) {
    OVERDUE("已过期"),
    TODAY("今天"),
    WEEK("本周"),
    LATER("更晚"),
    NONE("无期限"),
}

internal fun dueGroup(due: String?, today: LocalDate = LocalDate.now()): DueGroup {
    if (due.isNullOrBlank()) return DueGroup.NONE
    val date = try {
        java.time.Instant.parse(due).atZone(ZoneId.systemDefault()).toLocalDate()
    } catch (_: Exception) {
        try {
            LocalDate.parse(due.take(10))
        } catch (_: Exception) {
            return DueGroup.NONE
        }
    }
    val dayDiff = java.time.temporal.ChronoUnit.DAYS.between(today, date)
    return when {
        dayDiff < 0 -> DueGroup.OVERDUE
        dayDiff == 0L -> DueGroup.TODAY
        dayDiff <= 7 -> DueGroup.WEEK
        else -> DueGroup.LATER
    }
}

data class TodosUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val notes: List<Note> = emptyList(),
)

class TodosViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as SuinianApp).repository

    private val _ui = MutableStateFlow(TodosUiState())
    val ui: StateFlow<TodosUiState> = _ui

    init {
        refresh()
    }

    fun refresh() {
        _ui.value = _ui.value.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                // 待办数量有限，翻页拉全（上限 5 页防御）
                val all = mutableListOf<Note>()
                var cursor: String? = null
                repeat(5) {
                    val page = repo.list(category = "todo", tag = null, q = null, cursor = cursor)
                    all += page.notes
                    cursor = page.cursor
                    if (cursor == null) return@repeat
                }
                _ui.value = _ui.value.copy(loading = false, notes = all.distinctBy { it.id })
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    fun toggle(note: Note) {
        val target = !(note.todoDone ?: false)
        _ui.value = _ui.value.copy(
            notes = _ui.value.notes.map { if (it.id == note.id) it.copy(todoDone = target) else it }
        )
        viewModelScope.launch {
            try {
                repo.setTodoDone(note.id, target)
            } catch (_: Exception) {
                _ui.value = _ui.value.copy(
                    notes = _ui.value.notes.map { if (it.id == note.id) it.copy(todoDone = note.todoDone) else it }
                )
            }
        }
    }
}

@Composable
fun TodosScreen(modifier: Modifier = Modifier, vm: TodosViewModel = viewModel()) {
    val ui by vm.ui.collectAsState()

    when {
        ui.loading && ui.notes.isEmpty() -> Column(
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
        ui.notes.isEmpty() -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) { Text("没有待办，轻松！", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        else -> {
            val open = ui.notes.filter { it.todoDone != true }
                .sortedWith(compareBy(nullsLast()) { it.todoDue })
            val done = ui.notes.filter { it.todoDone == true }
            val groups = DueGroup.entries.mapNotNull { g ->
                val list = open.filter { dueGroup(it.todoDue) == g }
                if (list.isEmpty()) null else g to list
            }
            LazyColumn(
                modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                groups.forEach { (group, list) ->
                    item(key = "header-${group.name}") {
                        Text(
                            "${group.label}（${list.size}）",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = if (group == DueGroup.OVERDUE) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                    items(list, key = { it.id }) { note ->
                        NoteCard(note, onToggleTodo = { vm.toggle(it) })
                    }
                }
                if (done.isNotEmpty()) {
                    item(key = "header-done") {
                        Text(
                            "已完成（${done.size}）",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                    items(done, key = { it.id }) { note ->
                        NoteCard(note, onToggleTodo = { vm.toggle(it) })
                    }
                }
                item { Spacer(Modifier.height(24.dp)) }
            }
        }
    }
}
