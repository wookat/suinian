package com.zalize.suinian.ui.components

import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.zalize.suinian.data.NoteAttachment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/** 附件类型判定：优先 mime，回退文件扩展名 */
fun isImageAttachment(att: NoteAttachment): Boolean =
    att.mime?.startsWith("image/") == true ||
        att.name.substringAfterLast('.', "").lowercase() in setOf("jpg", "jpeg", "png", "gif", "webp", "bmp")

fun isAudioAttachment(att: NoteAttachment): Boolean =
    att.mime?.startsWith("audio/") == true ||
        att.name.substringAfterLast('.', "").lowercase() in setOf("mp3", "m4a", "aac", "wav", "ogg", "amr", "opus")

/**
 * 列表刷新 / 网络恢复时自动清附件失败态：reloadKey 变化且当前失败值得重拉（连接级 / 5xx）才重新发起，
 * 404 / Token 失效等重拉也不会变的失败保持原样等用户点击。首次进入组合不算变化。
 */
@Composable
private fun AutoReloadOnKey(
    reloadKey: Int,
    failed: Boolean,
    autoRetry: Boolean,
    retry: () -> Unit,
) {
    var seenKey by remember { mutableIntStateOf(reloadKey) }
    LaunchedEffect(reloadKey) {
        if (reloadKey == seenKey) return@LaunchedEffect
        seenKey = reloadKey
        if (failed && autoRetry) retry()
    }
}

/** 图片附件：鉴权拉取原图，卡片内缩略图，点击全屏查看；reloadKey 由列表层在刷新成功 / 网络恢复时递增 */
@Composable
fun NoteImageAttachment(
    noteId: String,
    attachment: NoteAttachment,
    fetchMedia: suspend (noteId: String, attachmentId: String) -> Pair<ByteArray, String>,
    modifier: Modifier = Modifier,
    reloadKey: Int = 0,
) {
    var bitmap by remember(noteId, attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(noteId, attachment.id) { mutableStateOf(false) }
    var failReason by remember(noteId, attachment.id) { mutableStateOf<String?>(null) }
    var failAutoRetries by remember(noteId, attachment.id) { mutableStateOf(false) }
    var loadAttempt by remember(noteId, attachment.id) { mutableIntStateOf(0) }
    var fullscreen by remember { mutableStateOf(false) }

    LaunchedEffect(noteId, attachment.id, loadAttempt) {
        if (bitmap != null || failed) return@LaunchedEffect
        try {
            val (bytes, _) = fetchMedia(noteId, attachment.id)
            val bmp = withContext(Dispatchers.Default) { decodeSampledBitmap(bytes) }
            if (bmp != null) {
                bitmap = bmp.asImageBitmap()
            } else {
                failReason = "图片格式无法解码"
                failAutoRetries = false
                failed = true
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failReason = mediaLoadFailureReason(e)
            failAutoRetries = mediaLoadFailureAutoRetries(e)
            failed = true
        }
    }

    val retry: () -> Unit = {
        failed = false
        failReason = null
        loadAttempt++
    }
    AutoReloadOnKey(reloadKey, failed, failAutoRetries, retry)

    val bmp = bitmap
    when {
        bmp != null -> {
            Image(
                bitmap = bmp,
                contentDescription = "笔记图片",
                contentScale = ContentScale.Crop,
                modifier = modifier
                    .fillMaxWidth()
                    .heightIn(max = 220.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable { fullscreen = true },
            )
            if (fullscreen) {
                Dialog(
                    onDismissRequest = { fullscreen = false },
                    properties = DialogProperties(usePlatformDefaultWidth = false),
                ) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.92f))
                            .clickable { fullscreen = false },
                        contentAlignment = Alignment.Center,
                    ) {
                        Image(
                            bitmap = bmp,
                            contentDescription = "笔记图片（大图）",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.fillMaxSize().padding(12.dp),
                        )
                    }
                }
            }
        }
        failed -> MediaLoadFailed(
            label = "图片加载失败",
            reason = failReason,
            onRetry = retry,
            modifier = modifier,
        )
        else -> Box(
            modifier
                .fillMaxWidth()
                .heightIn(min = 72.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surface),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        }
    }
}

/**
 * 语音附件：鉴权拉取原音频到落盘缓存，MediaPlayer 直接读缓存文件；显示时长与播放进度，
 * 同一时刻只放一段（新卡开播时上一张暂停）；本机播放器放不出来的文件给「下载原件」而不是重拉同一份缓存。
 * reloadKey 同 NoteImageAttachment。
 */
@Composable
fun NoteAudioAttachment(
    noteId: String,
    attachment: NoteAttachment,
    fetchMediaFile: suspend (noteId: String, attachmentId: String) -> File,
    modifier: Modifier = Modifier,
    reloadKey: Int = 0,
    onDownload: (() -> Unit)? = null,
) {
    var audioFile by remember(noteId, attachment.id) { mutableStateOf<File?>(null) }
    var durationMs by remember(noteId, attachment.id) { mutableStateOf<Long?>(null) }
    var failed by remember(noteId, attachment.id) { mutableStateOf(false) }
    var failReason by remember(noteId, attachment.id) { mutableStateOf<String?>(null) }
    var failAutoRetries by remember(noteId, attachment.id) { mutableStateOf(false) }
    var playFailed by remember(noteId, attachment.id) { mutableStateOf(false) }
    var loadAttempt by remember(noteId, attachment.id) { mutableIntStateOf(0) }
    var playing by remember { mutableStateOf(false) }
    var prepared by remember { mutableStateOf(false) }
    var positionMs by remember { mutableLongStateOf(0L) }
    val player = remember { MediaPlayer() }

    LaunchedEffect(noteId, attachment.id, loadAttempt) {
        if (audioFile != null || failed) return@LaunchedEffect
        try {
            val f = fetchMediaFile(noteId, attachment.id)
            audioFile = f
            if (durationMs == null) durationMs = readAudioDurationMs(f)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failReason = mediaLoadFailureReason(e)
            failAutoRetries = mediaLoadFailureAutoRetries(e)
            failed = true
        }
    }

    LaunchedEffect(playing) {
        while (playing) {
            positionMs = try {
                player.currentPosition.toLong()
            } catch (_: Exception) {
                positionMs
            }
            delay(250)
        }
    }

    val retry: () -> Unit = {
        failed = false
        failReason = null
        audioFile = null
        loadAttempt++
    }
    AutoReloadOnKey(reloadKey, failed, failAutoRetries, retry)

    DisposableEffect(Unit) {
        onDispose {
            AudioPlaybackArbiter.release(player)
            try {
                player.release()
            } catch (_: Exception) {
            }
        }
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            when {
                failed -> MediaLoadFailed(
                    label = "语音加载失败",
                    reason = failReason,
                    onRetry = retry,
                )
                playFailed -> AudioUnplayable(onDownload = onDownload)
                audioFile == null -> {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "语音加载中…",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                else -> {
                    IconButton(
                        onClick = {
                            try {
                                if (playing) {
                                    player.pause()
                                    playing = false
                                    AudioPlaybackArbiter.release(player)
                                } else {
                                    if (!prepared) {
                                        val f = audioFile!!
                                        if (!f.isFile) {
                                            // 缓存已被容量淘汰 / 退出登录清空：重新取一次再播
                                            audioFile = null
                                            loadAttempt++
                                            return@IconButton
                                        }
                                        player.reset()
                                        player.setDataSource(f.absolutePath)
                                        player.prepare()
                                        prepared = true
                                        player.duration.toLong().takeIf { it > 0 }?.let { durationMs = it }
                                        player.setOnCompletionListener {
                                            playing = false
                                            positionMs = 0L
                                            AudioPlaybackArbiter.release(it)
                                            it.seekTo(0)
                                        }
                                    }
                                    AudioPlaybackArbiter.claim(player) {
                                        try {
                                            player.pause()
                                        } catch (_: Exception) {
                                        }
                                        playing = false
                                    }
                                    player.start()
                                    playing = true
                                }
                            } catch (_: Exception) {
                                playing = false
                                prepared = false
                                AudioPlaybackArbiter.release(player)
                                playFailed = true
                            }
                        },
                        modifier = Modifier.size(32.dp),
                    ) {
                        Icon(
                            if (playing) Icons.Outlined.Pause else Icons.Outlined.PlayArrow,
                            contentDescription = if (playing) "暂停" else "播放语音",
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    val total = formatAudioClock(durationMs)
                    val inProgress = playing || positionMs > 0
                    Column(Modifier.weight(1f)) {
                        Text(
                            audioClockLabel(playing, inProgress, formatAudioClock(positionMs), total),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val progress = if (inProgress) audioProgress(positionMs, durationMs) else null
                        if (progress != null) {
                            Spacer(Modifier.height(4.dp))
                            LinearProgressIndicator(
                                progress = { progress },
                                modifier = Modifier.fillMaxWidth().height(3.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 本机播放器放不出来（格式不受支持 / 文件损坏）：重拉同一份缓存没有意义，给「下载原件」换其他应用播 */
@Composable
private fun RowScope.AudioUnplayable(onDownload: (() -> Unit)?) {
    Icon(
        Icons.Outlined.ErrorOutline,
        contentDescription = null,
        tint = MaterialTheme.colorScheme.error,
        modifier = Modifier.size(14.dp),
    )
    Spacer(Modifier.width(4.dp))
    Column(Modifier.weight(1f)) {
        Text(
            "这段语音无法在本机播放",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error,
        )
        Text(
            "格式可能不受支持或文件已损坏" + if (onDownload != null) "，可下载原件用其他应用打开" else "",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (onDownload != null) {
        TextButton(onClick = onDownload, contentPadding = PaddingValues(horizontal = 8.dp)) {
            Icon(Icons.Outlined.Download, contentDescription = null, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text("下载原件", style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** 落盘后读一次时长（MediaMetadataRetriever，IO 线程，失败返回 null 由播放时 MediaPlayer.duration 兜底） */
private suspend fun readAudioDurationMs(file: File): Long? = withContext(Dispatchers.IO) {
    val r = MediaMetadataRetriever()
    try {
        r.setDataSource(file.absolutePath)
        r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()?.takeIf { it > 0 }
    } catch (_: Exception) {
        null
    } finally {
        try {
            r.release()
        } catch (_: Exception) {
        }
    }
}

/** 附件加载失败态：原因（网络 / 服务端 / 缓存的可读文案）+ 点击整行重试，不用等滑出屏幕再滑回来 */
@Composable
private fun MediaLoadFailed(
    label: String,
    reason: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onRetry)
            .padding(vertical = 2.dp),
    ) {
        Icon(
            Icons.Outlined.Refresh,
            contentDescription = "重试加载",
            tint = MaterialTheme.colorScheme.error,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(4.dp))
        Column {
            Text(
                "$label，点击重试",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
            if (reason != null) {
                Text(
                    reason,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
