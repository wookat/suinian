package com.zalize.suinian.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
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

/** 分享入的一条内容（图片带 uri，确认后读字节上传） */
private data class SharedItem(val rawType: String, val content: String, val url: String?, val imageUri: Uri? = null)

private const val MAX_IMAGE_BYTES = 10 * 1024 * 1024

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

        when (action) {
            Intent.ACTION_SEND -> {
                if (type.startsWith("image/")) {
                    @Suppress("DEPRECATION")
                    addImage(intent.getParcelableExtra(Intent.EXTRA_STREAM))
                } else {
                    addText(intent.getStringExtra(Intent.EXTRA_TEXT))
                }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                if (type.startsWith("image/")) {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.forEach { addImage(it) }
                } else {
                    intent.getStringArrayListExtra(Intent.EXTRA_TEXT)?.forEach { addText(it) }
                }
            }
        }
        return items
    }

    private fun sendAll(items: List<SharedItem>, remark: String) {
        val app = application as SuinianApp
        lifecycleScope.launch {
            var queued = false
            var failed = 0
            var uploadedImages = 0
            for (item in items) {
                if (item.imageUri != null) {
                    // 图片：读字节 -> POST /api/ingest/media type=image（后端视觉识别成文字笔记）
                    try {
                        val bytes = contentResolver.openInputStream(item.imageUri)?.use { it.readBytes() }
                        if (bytes == null || bytes.isEmpty()) {
                            failed++
                            continue
                        }
                        if (bytes.size > MAX_IMAGE_BYTES) {
                            Toast.makeText(this@ShareActivity, "图片过大：最多 10MB", Toast.LENGTH_SHORT).show()
                            failed++
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
                    }
                    continue
                }
                val content = if (remark.isBlank()) item.content else "${item.content}\n\n备注：${remark.trim()}"
                val result = app.repository.send(
                    CreateNoteRequest(source = "android", rawType = item.rawType, content = content, url = item.url)
                )
                if (result is SendResult.Queued) queued = true
            }
            val msg = when {
                failed > 0 && uploadedImages == 0 && items.all { it.imageUri != null } -> "图片上传失败，请检查网络后重试"
                failed > 0 -> "部分内容上传失败（$failed 条）"
                queued -> "网络不佳，已暂存稍后自动重试"
                uploadedImages > 0 -> "已上传，AI 正在识别图片文字"
                items.size > 1 -> "已存 ${items.size} 条到碎念"
                else -> "已存到碎念"
            }
            Toast.makeText(this@ShareActivity, msg, Toast.LENGTH_SHORT).show()
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
                        if (item.rawType == "image") {
                            Icon(
                                Icons.Outlined.Image,
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
