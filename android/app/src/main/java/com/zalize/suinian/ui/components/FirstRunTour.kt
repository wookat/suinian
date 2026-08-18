package com.zalize.suinian.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

private data class TourStep(val icon: ImageVector, val title: String, val description: String)

private val TOUR_STEPS = listOf(
    TourStep(
        Icons.Outlined.Edit,
        "想到什么，随手丢",
        "想法、待办、链接、账目……都能打进速记框，发送就存。不用想放哪儿、也不用打标签。",
    ),
    TourStep(
        Icons.Outlined.AutoAwesome,
        "AI 自动分拣",
        "每一条都会被自动分类（想法 / 待办 / 收藏 / 资料）并打上标签；同一个话题的碎片还会自动串成「思考线索」。",
    ),
    TourStep(
        Icons.AutoMirrored.Outlined.HelpOutline,
        "问一句就找回",
        "速记框里以「?」开头提问，或切到「问答」页——AI 直接从你的笔记里找答案并给出出处。",
    ),
    TourStep(
        Icons.Outlined.Share,
        "哪里都能丢进来",
        "系统分享面板、桌面小组件、通知栏速记、微信 bot、浏览器剪藏扩展都能直达这里。",
    ),
)

/** 新注册用户首次进入时间流的一次性 4 步功能引导，可跳过，看过不再显示 */
@Composable
fun FirstRunTour(onDone: () -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    val current = TOUR_STEPS[step]
    val last = step == TOUR_STEPS.lastIndex

    AlertDialog(
        onDismissRequest = {},
        title = null,
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "${step + 1} / ${TOUR_STEPS.size}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                Box(
                    Modifier
                        .size(56.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.secondaryContainer),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(current.icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
                }
                Spacer(Modifier.height(12.dp))
                Text(current.title, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                Text(
                    current.description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.heightIn(min = 72.dp),
                )
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    TOUR_STEPS.forEachIndexed { i, _ ->
                        Box(
                            Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(
                                    if (i == step) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.surfaceVariant
                                )
                                .clickable { step = i },
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { if (last) onDone() else step += 1 }) {
                Text(if (last) "开始使用" else "下一步")
            }
        },
        dismissButton = {
            TextButton(onClick = onDone) { Text("跳过") }
        },
    )
}
