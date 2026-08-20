package com.zalize.suinian.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
    "expense" to "支出",
    "income" to "收入",
    "transfer" to "资金往来",
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

private val CURRENCY_SYMBOL = mapOf(
    "CNY" to "¥",
    "USD" to "$",
    "EUR" to "€",
    "GBP" to "£",
    "JPY" to "JP¥",
    "HKD" to "HK$",
)

/** 金额展示（对齐 Web formatAmount）：已知币种用符号，否则「数值 币种码」 */
fun formatAmount(amount: Double, currency: String): String {
    val sym = CURRENCY_SYMBOL[currency]
    val num = if (amount == Math.floor(amount) && !amount.isInfinite()) {
        amount.toLong().toString()
    } else {
        "%.2f".format(amount)
    }
    return if (sym != null) "$sym$num" else "$num $currency"
}

private const val MAX_LINK_CARDS = 3

/** 链接抓取失败态文案（对齐 Web LINK_STATUS_TEXT） */
private val linkStatusText = mapOf(
    "fetch_failed" to "未能抓取正文，已保存链接",
    "no_content" to "未能提取正文，已保存链接",
)

/** 文件类型标签 */
fun fileKindLabel(kind: String?, mime: String?): String = when (kind) {
    "pdf" -> "PDF"
    "txt" -> "TXT"
    "md" -> "Markdown"
    "docx" -> "Word"
    else -> mime ?: "文件"
}

/** 文件大小可读化 */
fun formatFileSize(size: Long?): String? {
    if (size == null || size <= 0) return null
    if (size < 1024) return "$size B"
    if (size < 1024 * 1024) return "%.1f KB".format(size / 1024.0)
    return "%.1f MB".format(size / 1024.0 / 1024.0)
}

private fun linkCards(note: Note): List<UrlTitle> {
    val multi = note.urlTitles
    if (!multi.isNullOrEmpty()) return multi.take(MAX_LINK_CARDS)
    val url = note.url ?: return emptyList()
    return listOf(UrlTitle(url = url, title = note.urlTitle))
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun NoteCard(
    note: Note,
    modifier: Modifier = Modifier,
    onToggleTodo: ((Note) -> Unit)? = null,
    onDelete: ((Note) -> Unit)? = null,
    onToggleSensitive: ((Note) -> Unit)? = null,
    /** 敏感标记 PATCH 在途：菜单项禁用防连发（R206 P2-2） */
    sensitivePending: Boolean = false,
    onRetryLink: ((Note) -> Unit)? = null,
    retryingLink: Boolean = false,
    onDownloadFile: ((Note) -> Unit)? = null,
    onEdit: ((Note) -> Unit)? = null,
    selectable: Boolean = false,
    selected: Boolean = false,
    onSelectToggle: ((Note) -> Unit)? = null,
    onLongPress: ((Note) -> Unit)? = null,
    fetchMedia: (suspend (noteId: String, attachmentId: String) -> Pair<ByteArray, String>)? = null,
) {
    var confirmDelete by rememberSaveable(note.id) { mutableStateOf(false) }
    // 敏感遮罩：点击临时查看，可再隐藏（对齐 Web）；遮罩时标题/链接卡/文件摘录/图片描述/金额一律不露出
    var revealed by rememberSaveable(note.id) { mutableStateOf(false) }
    val masked = note.isSensitive && !revealed
    if (confirmDelete && onDelete != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("删除这条笔记？") },
            text = { Text("将移入「最近删除」，30 天内可从设置页恢复") },
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
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (selectable || onLongPress != null) {
                    Modifier.combinedClickable(
                        onClick = { if (selectable) onSelectToggle?.invoke(note) },
                        onLongClick = { if (!selectable) onLongPress?.invoke(note) },
                    )
                } else Modifier
            ),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f)
            else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        ),
        border = if (selected) BorderStroke(1.dp, MaterialTheme.colorScheme.primary) else null,
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                if (selectable) {
                    Checkbox(
                        checked = selected,
                        onCheckedChange = { onSelectToggle?.invoke(note) },
                        modifier = Modifier.size(28.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                CategoryBadge(note.category)
                if (note.isSensitive) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "敏感",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.5f))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
                SourceBadge(note.rawType)
                if (note.match == "semantic") {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "语义匹配",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f))
                            .padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    formatRelativeTime(note.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                if (!selectable && onToggleSensitive != null) {
                    var menuOpen by rememberSaveable(note.id) { mutableStateOf(false) }
                    IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(28.dp)) {
                        Icon(
                            Icons.Outlined.MoreVert,
                            contentDescription = "笔记操作",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            if (onEdit != null) {
                                DropdownMenuItem(
                                    text = { Text("编辑") },
                                    leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                                    onClick = {
                                        menuOpen = false
                                        onEdit(note)
                                    },
                                )
                            }
                            DropdownMenuItem(
                                text = { Text(if (sensitivePending) "更新中…" else if (note.isSensitive) "取消敏感" else "标记敏感") },
                                enabled = !sensitivePending,
                                leadingIcon = {
                                    if (sensitivePending) {
                                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                    } else {
                                        Icon(
                                            if (note.isSensitive) Icons.Outlined.Visibility else Icons.Outlined.VisibilityOff,
                                            contentDescription = null,
                                        )
                                    }
                                },
                                onClick = {
                                    menuOpen = false
                                    onToggleSensitive(note)
                                },
                            )
                            if (onDelete != null) {
                                DropdownMenuItem(
                                    text = { Text("删除") },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null) },
                                    onClick = {
                                        menuOpen = false
                                        confirmDelete = true
                                    },
                                )
                            }
                        }
                    }
                } else if (onDelete != null) {
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
            if (title != null && !masked) {
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
            if (masked) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .clickable { revealed = true },
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
                Spacer(Modifier.height(4.dp))
                Text(
                    "检测到密码/凭据类信息，已自动加密保护，不进入问答与搜索；若属误判，可在菜单中取消敏感标记",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f),
                )
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

            // 敏感已展示：提供「隐藏」收回
            if (note.isSensitive && revealed) {
                Spacer(Modifier.height(4.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .clickable { revealed = false }
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

            // 收支记账：金额/币种（支出负号、收入正号）+ 商户/用途
            if ((note.category == "expense" || note.category == "income" || note.category == "transfer") && !masked) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val income = note.category == "income"
                    val transfer = note.category == "transfer"
                    // transfer 是资金平移：无正负号（对齐 Web 的 ⇄ 前缀），中性色
                    val amountText = note.amount?.let {
                        (if (income) "+" else if (transfer) "⇄" else "-") + formatAmount(it, note.currency ?: "CNY")
                    } ?: (if (transfer) "资金往来" else "金额待定")
                    Text(
                        amountText,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = if (income) MaterialTheme.colorScheme.tertiary
                        else if (transfer) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.error,
                    )
                    val merchant = note.meta?.financeMerchant?.takeIf { it.isNotBlank() }
                    if (merchant != null) {
                        Spacer(Modifier.width(6.dp))
                        Text(
                            merchant,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
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
            (if (masked) emptyList() else linkCards(note)).forEachIndexed { i, card ->
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
                        // R34：回退标题已含域名时不重复显示站点（对齐 Web）
                        val showSite = isFirst && note.meta?.linkSite != null &&
                            card.title?.startsWith(note.meta.linkSite) != true
                        if (showSite && note.meta?.linkSite != null) {
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
                        val failText = if (isFirst) linkStatusText[note.meta?.linkStatus] else null
                        if (failText != null) {
                            Spacer(Modifier.height(4.dp))
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    failText,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                    modifier = Modifier.weight(1f),
                                )
                                if (onRetryLink != null) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(6.dp))
                                            .clickable(enabled = !retryingLink) { onRetryLink(note) }
                                            .padding(horizontal = 6.dp, vertical = 2.dp),
                                    ) {
                                        Icon(
                                            Icons.Outlined.Refresh,
                                            contentDescription = null,
                                            tint = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.size(14.dp),
                                        )
                                        Spacer(Modifier.width(2.dp))
                                        Text(
                                            if (retryingLink) "重试中…" else "重试抓取",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                            }
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

            // 文件笔记卡：文件名/类型/大小 + 正文摘录（可展开）+ 下载原件
            val fileMeta = note.meta?.takeIf { note.rawType == "file" && it.fileName != null }
            if (fileMeta != null && !masked) {
                Spacer(Modifier.height(8.dp))
                Card(
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
                ) {
                    Column(Modifier.fillMaxWidth().padding(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Outlined.Description,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.width(6.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    fileMeta.fileName ?: "",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                val sizeText = formatFileSize(fileMeta.fileSize)
                                Text(
                                    fileKindLabel(fileMeta.fileKind, fileMeta.fileMime) +
                                        (sizeText?.let { " · $it" } ?: ""),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (onDownloadFile != null) {
                                IconButton(onClick = { onDownloadFile(note) }, modifier = Modifier.size(32.dp)) {
                                    Icon(
                                        Icons.Outlined.Download,
                                        contentDescription = "下载原件",
                                        tint = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                        if (fileMeta.fileStatus == "extract_failed") {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                "文本提取失败，已存档原件",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        val excerpt = fileMeta.fileExcerpt?.takeIf { it.isNotBlank() }
                        if (excerpt != null) {
                            var fileExcerptOpen by rememberSaveable(note.id) { mutableStateOf(false) }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                if (fileExcerptOpen) "收起正文摘录" else "查看正文摘录",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(4.dp))
                                    .clickable { fileExcerptOpen = !fileExcerptOpen }
                                    .padding(vertical = 2.dp),
                            )
                            if (fileExcerptOpen) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    excerpt,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }

            // 附件原件：图片缩略图+点击大图 / 语音可播放（敏感遮罩时不加载不展示）
            if (fetchMedia != null && !masked) {
                val imageAtt = if (note.rawType == "image") note.attachments?.firstOrNull(::isImageAttachment) else null
                val audioAtt = if (note.rawType == "voice") note.attachments?.firstOrNull(::isAudioAttachment) else null
                if (imageAtt != null) {
                    Spacer(Modifier.height(8.dp))
                    NoteImageAttachment(note.id, imageAtt, fetchMedia)
                }
                if (audioAtt != null) {
                    Spacer(Modifier.height(8.dp))
                    NoteAudioAttachment(note.id, audioAtt, fetchMedia)
                }
            }

            // 图片笔记：视觉模型完整描述可展开（文字优先，描述作补充）
            val imageDescription = note.meta?.imageDescription
                ?.takeIf { note.rawType == "image" && it.isNotBlank() && it != note.content }
            if (imageDescription != null && !masked) {
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

            // 遮罩态不外显派生标签（R154 P2-3）：与标题/正文同口径，揭示后才展示
            if (!masked && note.tags.isNotEmpty()) {
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

/** 来源角标：语音转写 / 图片识别 / 文件 */
@Composable
fun SourceBadge(rawType: String) {
    val (icon, label) = when (rawType) {
        "voice" -> Icons.Outlined.Mic to "语音转写"
        "image" -> Icons.Outlined.Image to "图片识别"
        "file" -> Icons.Outlined.Description to "文件"
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
