package com.zalize.suinian.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.UrlTitle
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

private val categories = listOf(
    null to "全部",
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
)

fun categoryLabel(category: String?): String {
    if (category == null) return "分拣中"
    return categories.firstOrNull { it.first == category }?.second ?: category
}

private val dateFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")
private val dateFormatterWithYear = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

/** 后端时间容错解析：兼容 ISO-8601 与 D1 的 "yyyy-MM-dd HH:mm[:ss]"（UTC） */
fun parseInstantLenient(raw: String): Instant? {
    try {
        return Instant.parse(raw)
    } catch (_: Exception) {
    }
    val normalized = raw.trim().replace(' ', 'T')
    try {
        return LocalDateTime.parse(normalized).toInstant(ZoneOffset.UTC)
    } catch (_: Exception) {
    }
    return try {
        LocalDate.parse(normalized.take(10)).atStartOfDay().toInstant(ZoneOffset.UTC)
    } catch (_: Exception) {
        null
    }
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前，超 7 天显日期（对齐 Web formatTime） */
fun formatRelativeTime(iso: String, now: Instant = Instant.now()): String = try {
    val t = parseInstantLenient(iso) ?: throw IllegalArgumentException(iso)
    val minutes = Duration.between(t, now).toMinutes()
    when {
        minutes < 1 -> "刚刚"
        minutes < 60 -> "$minutes 分钟前"
        minutes < 24 * 60 -> "${minutes / 60} 小时前"
        minutes < 7 * 24 * 60 -> "${minutes / (24 * 60)} 天前"
        else -> {
            val zoned = t.atZone(ZoneId.systemDefault())
            val sameYear = zoned.year == now.atZone(ZoneId.systemDefault()).year
            zoned.format(if (sameYear) dateFormatter else dateFormatterWithYear)
        }
    }
} catch (_: Exception) {
    iso.take(16).replace("T", " ")
}

/** 北京时间偏移：无偏移的旧格式 todo_due 按 +08:00 解释 */
private val CN_OFFSET: ZoneOffset = ZoneOffset.of("+08:00")

/** todo_due 容错解析：兼容带偏移 ISO、无偏移（按 +08:00）与纯日期（本地零点） */
fun parseDueInstant(raw: String): Instant? {
    val v = raw.trim().replace(' ', 'T')
    try {
        return OffsetDateTime.parse(v).toInstant()
    } catch (_: Exception) {
    }
    try {
        return LocalDateTime.parse(v).toInstant(CN_OFFSET)
    } catch (_: Exception) {
    }
    return try {
        LocalDate.parse(v.take(10)).atStartOfDay(ZoneId.systemDefault()).toInstant()
    } catch (_: Exception) {
        null
    }
}

/** 截止时间：含 HH:mm 按本地时区显示到分钟，否则只显日期 */
fun formatDue(iso: String): String = try {
    val hasTime = Regex("[T ]\\d{2}:\\d{2}").containsMatchIn(iso)
    val zoned = (parseDueInstant(iso) ?: throw IllegalArgumentException(iso)).atZone(ZoneId.systemDefault())
    if (hasTime) zoned.format(dateFormatter)
    else zoned.format(DateTimeFormatter.ofPattern("MM-dd"))
} catch (_: Exception) {
    iso.take(16).replace("T", " ")
}

private const val MAX_LINK_CARDS = 3

private fun linkCards(note: Note): List<UrlTitle> {
    val multi = note.urlTitles
    if (!multi.isNullOrEmpty()) return multi.take(MAX_LINK_CARDS)
    val url = note.url ?: return emptyList()
    return listOf(UrlTitle(url = url, title = note.urlTitle))
}

@Composable
fun NoteCard(
    note: Note,
    modifier: Modifier = Modifier,
    onToggleTodo: ((Note) -> Unit)? = null,
    onDelete: ((Note) -> Unit)? = null,
) {
    var confirmDelete by rememberSaveable(note.id) { mutableStateOf(false) }
    if (confirmDelete && onDelete != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除这条笔记？") },
            text = { Text("删除后不可恢复") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    onDelete(note)
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("取消") }
            },
        )
    }
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                CategoryBadge(note.category)
                SourceBadge(note.rawType)
                Spacer(Modifier.width(8.dp))
                Text(
                    formatRelativeTime(note.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (onDelete != null) {
                    IconButton(onClick = { confirmDelete = true }, modifier = Modifier.size(28.dp)) {
                        Icon(
                            Icons.Outlined.Delete,
                            contentDescription = "删除笔记",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            // AI 标题（title 为空显正文首行）
            val title = note.title?.takeIf { it.isNotBlank() }
            if (title != null && !note.isSensitive) {
                Spacer(Modifier.height(6.dp))
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(6.dp))
            val done = note.todoDone == true
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
            } else if (note.category == "todo" && onToggleTodo != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = done,
                        onCheckedChange = { onToggleTodo(note) },
                        modifier = Modifier.size(28.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        note.content,
                        style = MaterialTheme.typography.bodyMedium,
                        textDecoration = if (done) TextDecoration.LineThrough else null,
                        color = if (done) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.onSurface,
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
                        "截止 ${formatDue(note.todoDue)}" + if (done) " · 已完成" else "",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }

            // 链接卡片（多链接 ≤3）：首卡显站点 + AI 摘要（可展开）+ 正文摘录（可展开）
            var summaryOpen by rememberSaveable(note.id) { mutableStateOf(false) }
            var excerptOpen by rememberSaveable(note.id) { mutableStateOf(false) }
            linkCards(note).forEachIndexed { i, card ->
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
                                card.title ?: card.url,
                                style = MaterialTheme.typography.labelLarge,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                        }
                        val isFirst = i == 0 && card.url == note.url
                        if (isFirst && note.meta?.linkSite != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                note.meta.linkSite,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        if (isFirst && note.urlSummary != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                note.urlSummary,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = if (summaryOpen) Int.MAX_VALUE else 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable { summaryOpen = !summaryOpen },
                            )
                        }
                        if (isFirst && note.meta?.linkExcerpt != null) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                if (excerptOpen) "收起正文摘录" else "查看正文摘录",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable { excerptOpen = !excerptOpen }
                                    .padding(vertical = 2.dp),
                            )
                            if (excerptOpen) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    note.meta.linkExcerpt,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }

            // 图片笔记：视觉模型完整描述可展开（文字优先，描述作补充）
            val imageDescription = note.meta?.imageDescription
                ?.takeIf { note.rawType == "image" && it.isNotBlank() && it != note.content }
            if (imageDescription != null && !note.isSensitive) {
                var descOpen by rememberSaveable(note.id) { mutableStateOf(false) }
                Spacer(Modifier.height(6.dp))
                Text(
                    if (descOpen) "收起图片描述" else "查看图片描述",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .clickable { descOpen = !descOpen }
                        .padding(vertical = 2.dp),
                )
                if (descOpen) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        imageDescription,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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

/** 来源角标：语音转写 / 图片识别 */
@Composable
fun SourceBadge(rawType: String) {
    val (icon, label) = when (rawType) {
        "voice" -> Icons.Outlined.Mic to "语音转写"
        "image" -> Icons.Outlined.Image to "图片识别"
        else -> return
    }
    Spacer(Modifier.width(6.dp))
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.secondaryContainer)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSecondaryContainer,
            modifier = Modifier.size(12.dp),
        )
        Spacer(Modifier.width(3.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSecondaryContainer,
        )
    }
}

@Composable
fun CategoryBadge(category: String?) {
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
