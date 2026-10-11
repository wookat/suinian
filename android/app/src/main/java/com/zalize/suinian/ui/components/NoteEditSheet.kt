package com.zalize.suinian.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NotesViewLimits

private val editCategories = listOf(
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
)

/** 笔记编辑底部弹层：正文/标题/分类/标签/待办截止时间（PATCH /api/notes/:id，对齐 Web R36） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteEditSheet(
    note: Note,
    saving: Boolean,
    conflict: Note? = null,
    onDismissConflict: () -> Unit = {},
    onDismiss: () -> Unit,
    onSave: (content: String, title: String, category: String?, tags: List<String>, todoDue: String?) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var content by remember(note.id) { mutableStateOf(note.content) }
    var title by remember(note.id) { mutableStateOf(note.title ?: "") }
    var category by remember(note.id) { mutableStateOf(note.category) }
    var tags by remember(note.id) { mutableStateOf(note.tags) }
    var tagInput by remember(note.id) { mutableStateOf("") }
    val initialDue = remember(note.id, note.todoDue) { dueToInput(note.todoDue) }
    var due by remember(note.id) { mutableStateOf(initialDue) }
    val dueParsed = if (category == "todo") inputToDue(due) else DueInput.Empty
    val dueInvalid = dueParsed is DueInput.Invalid

    fun addTag() {
        val t = tagInput.trim().removePrefix("#")
        if (t.isNotEmpty() && t !in tags) tags = tags + t
        tagInput = ""
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState())
                .imePadding()
                .navigationBarsPadding(),
        ) {
            Text("编辑笔记", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(12.dp))

            if (conflict != null) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.tertiaryContainer, RoundedCornerShape(12.dp))
                        .padding(12.dp),
                ) {
                    Text(
                        "这条笔记刚被更新（可能来自其他设备或后台自动整理），你的输入仍保留在下方编辑框，可对照最新版本合并后再保存",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "最新版本：${conflict.content}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onTertiaryContainer,
                        maxLines = 6,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "放弃我的输入，改用最新版本",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable {
                            content = conflict.content
                            title = conflict.title ?: ""
                            category = conflict.category
                            tags = conflict.tags
                            due = dueToInput(conflict.todoDue)
                            onDismissConflict()
                        },
                    )
                }
                Spacer(Modifier.height(12.dp))
            }

            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("标题（可留空）") },
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))

            val overLimit = content.length > NotesViewLimits.MAX_CONTENT_CHARS
            OutlinedTextField(
                value = content,
                onValueChange = { content = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("正文") },
                minLines = 3,
                maxLines = 8,
                isError = overLimit || content.isBlank(),
                supportingText = when {
                    overLimit -> {
                        { Text("内容过长：最多 ${NotesViewLimits.MAX_CONTENT_CHARS} 字符") }
                    }
                    content.isBlank() -> {
                        { Text("正文不能为空") }
                    }
                    else -> null
                },
            )
            Spacer(Modifier.height(8.dp))

            Text("分类", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                editCategories.forEach { (value, label) ->
                    FilterChip(
                        selected = category == value,
                        onClick = { category = value },
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))

            Text("标签", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            if (tags.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    tags.forEach { tag ->
                        InputChip(
                            selected = false,
                            onClick = { tags = tags - tag },
                            label = { Text("#$tag") },
                            trailingIcon = {
                                Icon(Icons.Outlined.Close, contentDescription = "移除标签 $tag", Modifier.width(16.dp))
                            },
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = tagInput,
                    onValueChange = { tagInput = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("新标签") },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                )
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = { addTag() }, enabled = tagInput.isNotBlank()) {
                    Icon(Icons.Outlined.Add, contentDescription = "添加标签")
                }
            }

            if (category == "todo") {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = due,
                    onValueChange = { due = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("截止时间（可留空清除）") },
                    placeholder = { Text("2026-08-10 或 2026-08-10 18:00") },
                    singleLine = true,
                    isError = dueInvalid,
                    supportingText = if (dueInvalid) {
                        { Text("到期时间格式不支持：$DUE_INPUT_HINT") }
                    } else null,
                )
            }

            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onDismiss, modifier = Modifier.weight(1f), enabled = !saving) {
                    Text("取消")
                }
                Button(
                    onClick = {
                        if (tagInput.isNotBlank()) addTag()
                        onSave(
                            content.trim(),
                            title.trim(),
                            category,
                            tags,
                            when {
                                category != "todo" || due.trim() == initialDue.trim() -> note.todoDue
                                dueParsed is DueInput.Value -> dueParsed.due
                                else -> null
                            },
                        )
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !saving && content.isNotBlank() && !overLimit && !dueInvalid,
                ) { Text(if (saving) "保存中…" else "保存") }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
