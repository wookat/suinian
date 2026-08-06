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
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
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
import java.time.ZoneId
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

/** 相对时间：刚刚 / x 分钟前 / x 小时前，超 7 天显日期（对齐 Web formatTime） */
fun formatRelativeTime(iso: String, now: Instant = Instant.now()): String = try {
    val t = Instant.parse(iso)
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

/** 截止时间：含 HH:mm 显示到分钟，否则只显日期 */
fun formatDue(iso: String): String = try {
    val hasTime = Regex("[T ]\\d{2}:\\d{2}").containsMatchIn(iso)
    val zoned = Instant.parse(iso).atZone(ZoneId.systemDefault())
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
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryBadge(note.category)
                Spacer(Modifier.width(8.dp))
                Text(
                    formatRelativeTime(note.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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

            // 链接卡片（多链接 ≤3）
            linkCards(note).forEach { card ->
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
                            )
                        }
                        if (card.url == note.url && note.urlSummary != null) {
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
