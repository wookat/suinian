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
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Description
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
    val generating: Boolean = false,
    val generateError: String? = null,
    /** 空数据窗口的引导文案（非错误） */
    val generateNotice: String? = null,
    /** 周/月切换：week|month */
    val periodTab: String = "week",
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

    fun setPeriodTab(period: String) {
        _ui.value = _ui.value.copy(periodTab = period, generateError = null, generateNotice = null)
    }

    /** 手动生成本周/本月报告（POST /api/reports/generate period=week|month），成功后直接打开详情 */
    fun generate(onGenerated: (String) -> Unit) {
        if (_ui.value.generating) return
        _ui.value = _ui.value.copy(generating = true, generateError = null, generateNotice = null)
        viewModelScope.launch {
            try {
                val result = repo.generateReport("this", _ui.value.periodTab)
                val report = result.report
                if (report == null) {
                    _ui.value = _ui.value.copy(
                        generating = false,
                        generateNotice = result.message ?: "当前周期还没有记录，先去记几条碎念吧",
                    )
                    return@launch
                }
                _ui.value = _ui.value.copy(generating = false)
                refresh()
                onGenerated(report.id)
            } catch (e: Exception) {
                _ui.value = _ui.value.copy(
                    generating = false,
                    generateError = e.message ?: "生成失败，请稍后重试",
                )
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

/** 报告标题：周报「x月x日那周」，月报「x年x月」 */
internal fun reportLabel(period: String, weekStart: String): String = if (period == "month") {
    try {
        val d = LocalDate.parse(weekStart.take(10))
        "${d.year} 年 ${d.monthValue} 月"
    } catch (_: Exception) {
        weekStart
    }
} else {
    weekLabel(weekStart)
}

@Composable
fun ReportsScreen(
    modifier: Modifier = Modifier,
    vm: ReportsViewModel = viewModel(),
    onOpenReport: (String) -> Unit,
) {
    val ui by vm.ui.collectAsState()
    val isMonth = ui.periodTab == "month"
    val filtered = ui.reports.filter { it.period == ui.periodTab }

    val periodTabs: @Composable () -> Unit = {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = !isMonth,
                onClick = { vm.setPeriodTab("week") },
                label = { Text("周报") },
            )
            FilterChip(
                selected = isMonth,
                onClick = { vm.setPeriodTab("month") },
                label = { Text("月报") },
            )
        }
    }

    val generateButton: @Composable () -> Unit = {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Button(onClick = { vm.generate(onOpenReport) }, enabled = !ui.generating) {
                Icon(Icons.Outlined.AutoAwesome, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    if (ui.generating) "生成中，约需半分钟…"
                    else if (isMonth) "生成本月报告" else "生成本周报告"
                )
            }
            ui.generateError?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            ui.generateNotice?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }

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
        // 空态时周报/月报切换保持与列表态相同的顶部位置，避免切换 tab 时上下跳动
        filtered.isEmpty() -> Column(
            modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            periodTabs()
            Column(
                Modifier.fillMaxWidth().weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    if (isMonth) "还没有月报\n每月 1 日自动生成上月思考报告\n也可以随时手动生成"
                    else "还没有周报\n每周一自动生成本周思考报告\n也可以随时手动生成",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                generateButton()
            }
        }
        else -> LazyColumn(
            modifier = modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "tabs") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    periodTabs()
                }
            }
            item(key = "generate") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    generateButton()
                }
            }
            items(filtered, key = { it.id }) { report ->
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
                                reportLabel(report.period, report.weekStart),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                (if (report.period == "month") "月报" else "周报") + " · ${report.weekStart.take(10)}",
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
                title = { Text(ui.detail?.let { reportLabel(it.period, it.weekStart) } ?: "报告") },
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
