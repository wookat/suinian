package com.zalize.suinian.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Casino
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.StatsDaily
import com.zalize.suinian.data.StatsResponse
import com.zalize.suinian.ui.components.NoteCard
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

/** 分类/来源文案（对齐 Web insights CATEGORY_LABEL / SOURCE_LABEL） */
private val CATEGORY_LABEL = mapOf(
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
    "expense" to "支出",
    "income" to "收入",
    "pending" to "待分拣",
)

private val SOURCE_LABEL = mapOf(
    "wechat" to "微信",
    "android" to "Android",
    "web" to "Web 速记",
    "api" to "API",
    "extension" to "浏览器剪藏",
    "from-ask" to "问答存档",
    "import" to "导入",
    "mcp" to "MCP",
)

private val BAR_COLORS = listOf(
    Color(0xFF0EA5E9), // sky
    Color(0xFF8B5CF6), // violet
    Color(0xFF10B981), // emerald
    Color(0xFFF59E0B), // amber
    Color(0xFFF43F5E), // rose
    Color(0xFF06B6D4), // cyan
    Color(0xFF84CC16), // lime
    Color(0xFFD946EF), // fuchsia
)

/** GitHub 风格 52 周热力图（周日为列首，对齐 Web Heatmap） */
@Composable
private fun Heatmap(daily: List<StatsDaily>) {
    val counts = remember(daily) { daily.associate { it.date to it.count } }
    val max = remember(daily) { maxOf(1, daily.maxOfOrNull { it.count } ?: 0) }
    val today = LocalDate.now()
    var start = today.minusDays(364)
    start = start.minusDays(start.dayOfWeek.value.toLong() % 7) // back to Sunday
    val weeks = remember(daily) {
        val result = mutableListOf<List<LocalDate?>>()
        var cur = start
        while (!cur.isAfter(today)) {
            val week = (0..6).map { d ->
                val day = cur.plusDays(d.toLong())
                if (day.isAfter(today)) null else day
            }
            result.add(week)
            cur = cur.plusDays(7)
        }
        result
    }
    val emerald = Color(0xFF10B981)
    fun level(count: Int): Color = when {
        count == 0 -> Color.Gray.copy(alpha = 0.18f)
        count.toFloat() / max <= 0.25f -> emerald.copy(alpha = 0.35f)
        count.toFloat() / max <= 0.5f -> emerald.copy(alpha = 0.55f)
        count.toFloat() / max <= 0.75f -> emerald.copy(alpha = 0.8f)
        else -> emerald
    }
    val scrollState = rememberScrollState()
    LaunchedEffect(weeks) { scrollState.scrollTo(scrollState.maxValue) }
    Row(
        Modifier.horizontalScroll(scrollState),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        weeks.forEach { week ->
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                week.forEach { day ->
                    Box(
                        Modifier
                            .size(11.dp)
                            .clip(RoundedCornerShape(2.5.dp))
                            .background(
                                if (day == null) Color.Transparent
                                else level(counts[day.toString()] ?: 0)
                            ),
                    )
                }
            }
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, accent: Boolean = false, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                value,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                color = if (accent) Color(0xFFF97316) else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/** 横向条形分布（分类/来源共用，对齐 Web DistBars） */
@Composable
private fun DistBars(title: String, items: List<Triple<String, String, Int>>) {
    val total = items.sumOf { it.third }
    if (total == 0) return
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(10.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(10.dp)
                    .clip(RoundedCornerShape(5.dp)),
            ) {
                items.forEachIndexed { i, (key, _, count) ->
                    Box(
                        Modifier
                            .weight(count.toFloat().coerceAtLeast(0.01f))
                            .fillMaxSize()
                            .background(BAR_COLORS[i % BAR_COLORS.size]),
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            items.forEachIndexed { i, (_, label, count) ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(BAR_COLORS[i % BAR_COLORS.size]),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        label,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Text(count.toString(), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InsightsScreen(
    vm: NotesViewModel,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var stats by remember { mutableStateOf<StatsResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var randomNote by remember { mutableStateOf<Note?>(null) }
    var randomEmpty by remember { mutableStateOf(false) }
    var drawing by remember { mutableStateOf(false) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        loading = true
        error = null
        try {
            val tz = ZonedDateTime.now(ZoneId.systemDefault()).offset.totalSeconds / 60
            stats = vm.getStats(days = 365, tzOffsetMinutes = tz)
        } catch (e: Exception) {
            error = e.message ?: "加载统计失败，请稍后重试"
        } finally {
            loading = false
        }
    }

    fun draw() {
        drawing = true
        scope.launch {
            try {
                val note = vm.getRandomNote()
                randomNote = note
                randomEmpty = note == null
            } catch (_: Exception) {
                randomEmpty = true
            } finally {
                drawing = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("洞察") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        val s = stats
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

            s == null || s.totalNotes == 0 -> Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "还没有可统计的记录\n去首页丢下第一条碎念吧",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            else -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = 16.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                // 总览
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    StatTile("当前连续记录", "${s.streak.current} 天", accent = true, modifier = Modifier.weight(1f))
                    StatTile("最长连续记录", "${s.streak.longest} 天", modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    StatTile("总笔记数", s.totalNotes.toString(), modifier = Modifier.weight(1f))
                    StatTile("思考线索", s.threadCount.toString(), modifier = Modifier.weight(1f))
                }

                Spacer(Modifier.height(12.dp))

                // 热力图
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    ),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text("过去一年的记录", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(10.dp))
                        Heatmap(s.daily)
                    }
                }

                Spacer(Modifier.height(12.dp))

                // 随机漫步
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    ),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Outlined.Casino,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text("随机漫步", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            OutlinedButton(onClick = { draw() }, enabled = !drawing) {
                                Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text(if (randomNote == null) "抽一条旧笔记" else "再抽一条")
                            }
                        }
                        val note = randomNote
                        if (note != null) {
                            Spacer(Modifier.height(10.dp))
                            NoteCard(note = note)
                        } else {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                if (randomEmpty) "暂无可回看的笔记（敏感与示例笔记不参与随机漫步）"
                                else "从历史里随机翻出一条旧笔记，让旧想法重新浮现。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(12.dp))

                // 分布
                DistBars(
                    "分类分布",
                    s.categories.map { Triple(it.category, CATEGORY_LABEL[it.category] ?: it.category, it.count) },
                )
                Spacer(Modifier.height(12.dp))
                DistBars(
                    "来源分布",
                    s.sources.map { Triple(it.source, SOURCE_LABEL[it.source] ?: it.source, it.count) },
                )
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}
