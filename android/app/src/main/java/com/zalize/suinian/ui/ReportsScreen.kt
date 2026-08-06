package com.zalize.suinian.ui

import android.app.Application
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Description
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.Report
import com.zalize.suinian.data.ReportSummary
import com.zalize.suinian.ui.components.MarkdownText
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.LocalDate

data class ReportsUiState(
    val loading: Boolean = false,
    val error: String? = null,
    val reports: List<ReportSummary> = emptyList(),
    val detailLoading: Boolean = false,
    val detailError: String? = null,
    val detail: Report? = null,
)

class ReportsViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = (app as SuinianApp).repository

    private val _ui = MutableStateFlow(ReportsUiState())
    val ui: StateFlow<ReportsUiState> = _ui

    init {
        refresh()
    }

    fun refresh() {
        _ui.value = _ui.value.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val reports = repo.listReports()
                _ui.value = _ui.value.copy(loading = false, reports = reports)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(loading = false, error = e.message ?: "加载失败")
            }
        }
    }

    fun loadDetail(id: String) {
        _ui.value = _ui.value.copy(detailLoading = true, detailError = null, detail = null)
        viewModelScope.launch {
            try {
                val report = repo.getReport(id)
                _ui.value = _ui.value.copy(detailLoading = false, detail = report)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(detailLoading = false, detailError = e.message ?: "加载失败")
            }
        }
    }
}

/** 周起始日期 → 「x月x日那周」 */
internal fun weekLabel(weekStart: String): String = try {
    val d = LocalDate.parse(weekStart.take(10))
    "${d.monthValue} 月 ${d.dayOfMonth} 日那周"
} catch (_: Exception) {
    weekStart
}

@Composable
fun ReportsScreen(
    modifier: Modifier = Modifier,
    vm: ReportsViewModel = viewModel(),
    onOpenReport: (String) -> Unit,
) {
    val ui by vm.ui.collectAsState()

    when {
        ui.loading && ui.reports.isEmpty() -> Column(
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
        ui.reports.isEmpty() -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                "还没有周报\n每周一自动生成本周思考报告",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        else -> LazyColumn(
            modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(ui.reports, key = { it.id }) { report ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onOpenReport(report.id) },
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    ),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Row(
                        Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Outlined.Description,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text(
                                weekLabel(report.weekStart),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                "周报 · ${report.weekStart.take(10)}",
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
fun ReportDetailScreen(
    reportId: String,
    vm: ReportsViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val ui by vm.ui.collectAsState()

    LaunchedEffect(reportId) { vm.loadDetail(reportId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(ui.detail?.let { weekLabel(it.weekStart) } ?: "周报") },
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
                AssistChip(onClick = { vm.loadDetail(reportId) }, label = { Text("重试") })
            }
            else -> {
                val report = ui.detail ?: return@Scaffold
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(horizontal = 16.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    MarkdownText(report.contentMd)
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}
