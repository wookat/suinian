package com.zalize.suinian.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.data.CreateNoteRequest
import com.zalize.suinian.data.SendResult
import com.zalize.suinian.ui.theme.SuinianTheme
import kotlinx.coroutines.launch

/** 分享入的一条内容（图片/文件带 uri，确认后读字节上传） */
private data class SharedItem(
    val rawType: String,
    val content: String,
    val url: String?,
    val imageUri: Uri? = null,
    val fileUri: Uri? = null,
)

private const val MAX_IMAGE_BYTES = 10 * 1024 * 1024
private const val MAX_FILE_BYTES = 10 * 1024 * 1024

/** 后端可提取正文的文档类型：PDF / txt / md / docx / csv / xlsx（其余类型后端也会存档原件） */
private fun isSupportedDocument(mime: String?, name: String?): Boolean {
    when (mime?.substringBefore(';')?.trim()) {
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "text/comma-separated-values",
        "text/tab-separated-values",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        -> return true
    }
    val ext = name?.substringAfterLast('.', "")?.lowercase()
    return ext in setOf("pdf", "txt", "md", "markdown", "docx", "csv", "tsv", "xlsx")
}

/** 任何 app「分享 → 碎念」的轻量确认页 */
class ShareActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val items = extractItems(intent)
        if (items.isEmpty()) {
            Toast.makeText(this, "没有可接收的内容", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        setContent {
            SuinianTheme {
                ShareSheet(
                    items = items,
                    onCancel = { finish() },
                    onConfirm = { remark -> sendAll(items, remark) },
                )
            }
        }
    }

    private fun extractItems(intent: Intent): List<SharedItem> {
        val action = intent.action
        val type = intent.type ?: return emptyList()
        val items = mutableListOf<SharedItem>()

        fun addText(text: String?) {
            val t = text?.trim().orEmpty()
            if (t.isEmpty()) return
            val isLink = t.startsWith("http://") || t.startsWith("https://")
            items.add(SharedItem(if (isLink) "link" else "text", t, if (isLink) t else null))
        }

        fun addImage(uri: Uri?) {
            if (uri == null) return
            items.add(SharedItem("image", "[图片] ${uri.lastPathSegment ?: uri}", null, imageUri = uri))
        }

        fun addFile(uri: Uri?) {
            if (uri == null) return
            val name = displayName(uri) ?: uri.lastPathSegment ?: "文件"
            items.add(SharedItem("file", "[文件] $name", null, fileUri = uri))
        }

        fun addStream(uri: Uri?) {
            if (uri == null) return
            val mime = contentResolver.getType(uri) ?: type
            when {
                mime.startsWith("image/") -> addImage(uri)
                isSupportedDocument(mime, displayName(uri) ?: uri.lastPathSegment) -> addFile(uri)
                else -> Toast.makeText(this, "不支持的文件类型：目前支持 PDF / txt / md / docx / csv / xlsx", Toast.LENGTH_SHORT).show()
            }
        }

        when (action) {
            Intent.ACTION_SEND -> {
                if (type == "text/plain" && intent.getStringExtra(Intent.EXTRA_TEXT) != null) {
                    addText(intent.getStringExtra(Intent.EXTRA_TEXT))
                } else if (type.startsWith("text/") || type.startsWith("image/") || type.startsWith("application/")) {
                    @Suppress("DEPRECATION")
                    val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                    if (stream != null) addStream(stream) else addText(intent.getStringExtra(Intent.EXTRA_TEXT))
                } else {
                    addText(intent.getStringExtra(Intent.EXTRA_TEXT))
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                @Suppress("DEPRECATION")
                val streams = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                if (!streams.isNullOrEmpty()) {
                    streams.forEach { addStream(it) }
                } else {
                    intent.getStringArrayListExtra(Intent.EXTRA_TEXT)?.forEach { addText(it) }
                }
            }
        }
        return items
    }

    /** 从 ContentResolver 取文件显示名 */
    private fun displayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    private fun sendAll(items: List<SharedItem>, remark: String) {
        val app = application as SuinianApp
        lifecycleScope.launch {
            var queued = false
            var failed = 0
            var uploadedImages = 0
            var uploadedFiles = 0
            val failReasons = mutableListOf<String>()
            for (item in items) {
                if (item.imageUri != null) {
                    // 图片：读字节 -> POST /api/ingest/media type=image（后端视觉识别成文字笔记）
                    try {
                        val bytes = contentResolver.openInputStream(item.imageUri)?.use { it.readBytes() }
                        if (bytes == null || bytes.isEmpty()) {
                            failed++
                            failReasons.add("读取图片失败")
                            continue
                        }
                        if (bytes.size > MAX_IMAGE_BYTES) {
                            failed++
                            failReasons.add("图片过大：最多 10MB")
                            continue
                        }
                        val mime = contentResolver.getType(item.imageUri) ?: "image/jpeg"
                        val fileName = item.imageUri.lastPathSegment ?: "image"
                        app.repository.sendImage(bytes, mime, fileName)
                        uploadedImages++
                        if (remark.isNotBlank()) {
                            app.repository.send(
                                CreateNoteRequest(source = "android", rawType = "text", content = "备注：${remark.trim()}", url = null)
                            )
                        }
                    } catch (e: Exception) {
                        failed++
                        failReasons.add(e.message ?: "图片上传失败")
                    }
                    continue
                }
                if (item.fileUri != null) {
                    // 文件：读字节 -> POST /api/ingest/media type=file（后端提取正文+存档原件）
                    try {
                        val bytes = contentResolver.openInputStream(item.fileUri)?.use { it.readBytes() }
                        if (bytes == null || bytes.isEmpty()) {
                            failed++
                            failReasons.add("读取文件失败")
                            continue
                        }
                        if (bytes.size > MAX_FILE_BYTES) {
                            failed++
                            failReasons.add("文件过大：最多 10MB")
                            continue
                        }
                        val mime = contentResolver.getType(item.fileUri) ?: "application/octet-stream"
                        val fileName = displayName(item.fileUri) ?: item.fileUri.lastPathSegment ?: "file"
                        app.repository.sendFile(bytes, mime, fileName)
                        uploadedFiles++
                        if (remark.isNotBlank()) {
                            app.repository.send(
                                CreateNoteRequest(source = "android", rawType = "text", content = "备注：${remark.trim()}", url = null)
                            )
                        }
                    } catch (e: Exception) {
                        failed++
                        failReasons.add(e.message ?: "文件上传失败")
                    }
                    continue
                }
                val content = if (remark.isBlank()) item.content else "${item.content}\n\n备注：${remark.trim()}"
                val result = app.repository.send(
                    CreateNoteRequest(source = "android", rawType = item.rawType, content = content, url = item.url)
                )
                if (result is SendResult.Queued) queued = true
            }
            // 失败不静默：带上具体原因，部分成功时同时报成功与失败条数
            val reason = failReasons.firstOrNull()?.let { "：$it" } ?: ""
            val okCount = uploadedImages + uploadedFiles
            val msg = when {
                failed > 0 && okCount == 0 && items.all { it.imageUri != null || it.fileUri != null } -> "上传失败$reason"
                failed > 0 -> "$okCount 条已上传，$failed 条失败$reason"
                queued -> "网络不佳，已暂存稍后自动重试"
                uploadedFiles > 0 -> "已上传，AI 正在提取文件内容"
                uploadedImages > 0 -> "已上传，AI 正在识别图片文字"
                items.size > 1 -> "已存 ${items.size} 条到碎念"
                else -> "已存到碎念"
            }
            Toast.makeText(this@ShareActivity, msg, if (failed > 0) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
            finish()
        }
    }
}

@androidx.compose.runtime.Composable
private fun ShareSheet(
    items: List<SharedItem>,
    onCancel: () -> Unit,
    onConfirm: (remark: String) -> Unit,
) {
    var remark by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            shape = RoundedCornerShape(24.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(20.dp)) {
                Text("存到碎念", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(12.dp))

                items.take(3).forEach { item ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                        if (item.rawType == "image" || item.rawType == "file") {
                            Icon(
                                if (item.rawType == "file") Icons.Outlined.Description else Icons.Outlined.Image,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                        Text(
                            item.content,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (items.size > 3) {
                    Text(
                        "…共 ${items.size} 条",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = remark,
                    onValueChange = { remark = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("加一句备注（可选）") },
                    shape = RoundedCornerShape(14.dp),
                    maxLines = 2,
                )
                Spacer(Modifier.height(16.dp))
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    TextButton(onClick = onCancel, enabled = !sending) { Text("取消") }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = {
                            sending = true
                            onConfirm(remark)
                        },
                        enabled = !sending,
                    ) { Text(if (sending) "存入中…" else "存入") }
                }
            }
        }
    }
}
