package com.zalize.suinian.ui.components

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.DailyReviewItem
import java.time.LocalDate

/** 「今日回顾」记录日期：xxxx年x月x日 */
internal fun reviewDateLabel(iso: String): String = try {
    val d = LocalDate.parse(iso.take(10))
    "${d.year}年${d.monthValue}月${d.dayOfMonth}日"
} catch (_: Exception) {
    iso.take(10)
}

/** 首页顶部「今日回顾」卡：那年今日 / 上月今日 / 久未回看，可折叠、可翻下一条（对齐 Web DailyReview） */
@Composable
fun DailyReviewCard(items: List<DailyReviewItem>, modifier: Modifier = Modifier) {
    if (items.isEmpty()) return
    var collapsed by rememberSaveable { mutableStateOf(false) }
    var index by rememberSaveable { mutableIntStateOf(0) }
    // 敏感笔记：点击临时查看，可再隐藏（对齐 Web）
    var revealedIds by remember { mutableStateOf(setOf<String>()) }
    val item = items[index.coerceIn(0, items.lastIndex)]
    val note = item.note

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { collapsed = !collapsed },
            ) {
                Icon(
                    Icons.Outlined.EventRepeat,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "今日回顾",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    item.kindLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (items.size > 1) {
                    Text(
                        "${index + 1}/${items.size}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(4.dp))
                }
                Icon(
                    if (collapsed) Icons.Outlined.ExpandMore else Icons.Outlined.ExpandLess,
                    contentDescription = if (collapsed) "展开今日回顾" else "收起今日回顾",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
            AnimatedVisibility(visible = !collapsed) {
                Column {
                    Spacer(Modifier.height(6.dp))
                    val comment = item.comment?.takeIf { it.isNotBlank() }
                    if (comment != null) {
                        Text(
                            comment,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.height(6.dp))
                    }
                    val revealed = note.id in revealedIds
                    val masked = note.isSensitive && !revealed
                    val title = note.title?.takeIf { it.isNotBlank() }
                    if (title != null && !masked) {
                        Text(
                            title,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(2.dp))
                    }
                    if (masked) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .clickable { revealedIds = revealedIds + note.id },
                        ) {
                            Text(
                                "••••••••",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.width(8.dp))
                            Icon(
                                Icons.Outlined.Visibility,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.secondary,
                                modifier = Modifier.size(14.dp),
                            )
                            Spacer(Modifier.width(3.dp))
                            Text(
                                "敏感内容，点击查看",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.secondary,
                            )
                        }
                    } else {
                        Text(
                            note.content,
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 6,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (note.isSensitive) {
                            Spacer(Modifier.height(4.dp))
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .clickable { revealedIds = revealedIds - note.id }
                                    .padding(horizontal = 4.dp, vertical = 2.dp),
                            ) {
                                Icon(
                                    Icons.Outlined.VisibilityOff,
                                    contentDescription = "隐藏敏感内容",
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.size(14.dp),
                                )
                                Spacer(Modifier.width(3.dp))
                                Text(
                                    "隐藏",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(6.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            reviewDateLabel(note.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        note.tags.take(3).forEach { tag ->
                            Text(
                                "#$tag",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        if (items.size > 1) {
                            Text(
                                "翻下一条 →",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(6.dp))
                                    .clickable { index = (index + 1) % items.size }
                                    .padding(horizontal = 6.dp, vertical = 4.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
