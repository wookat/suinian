package com.zalize.suinian.ui.components

import android.media.MediaPlayer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File

/** 当前这条语音的播放态；[pausedAtMs] 只在暂停时有意义，播放中的实时位置用 [AudioPlayback.positionMs] 读 */
data class AudioNowPlaying(
    val key: String,
    val playing: Boolean,
    val durationMs: Long?,
    val pausedAtMs: Long,
)

/** 语音卡的 key：同一条笔记的同一个附件 */
fun audioPlaybackKey(noteId: String, attachmentId: String): String = "$noteId/$attachmentId"

/** 从 key 还原 noteId（删除笔记时停掉它的语音） */
fun audioPlaybackNoteId(key: String): String = key.substringBefore('/')

/**
 * 进程内唯一的语音播放器：一段语音只有一个 MediaPlayer，天然同一时刻只放一段；
 * 播放状态不挂在卡片上，卡片滑出屏幕 / 切筛选不中断，滑回来按 key 接回当前进度。
 * 只在主线程访问（Compose 点击、MediaPlayer 回调都在主 Looper）。
 */
object AudioPlayback {
    private var player: MediaPlayer? = null
    private var preparedKey: String? = null

    var now: AudioNowPlaying? by mutableStateOf(null)
        private set

    /**
     * 播放 / 暂停 [key] 对应的语音。换到另一条时上一条停止并回到开头。
     * `prepare()` 失败原样抛出，由卡片转成「无法播放」态；此时播放器已复位、不影响其他卡。
     */
    fun toggle(key: String, file: File) {
        val p = player ?: MediaPlayer().also { player = it }
        val cur = now
        if (cur != null && cur.key == key && preparedKey == key) {
            if (cur.playing) {
                p.pause()
                now = cur.copy(playing = false, pausedAtMs = p.currentPosition.toLong())
            } else {
                p.start()
                now = cur.copy(playing = true)
            }
            return
        }
        preparedKey = null
        now = null
        p.reset()
        try {
            p.setDataSource(file.absolutePath)
            p.prepare()
        } catch (e: Exception) {
            try {
                p.reset()
            } catch (_: Exception) {
            }
            throw e
        }
        preparedKey = key
        p.setOnCompletionListener { mp ->
            now = now?.takeIf { it.key == key }?.copy(playing = false, pausedAtMs = 0L)
            try {
                mp.seekTo(0)
            } catch (_: Exception) {
            }
        }
        p.setOnErrorListener { _, _, _ ->
            preparedKey = null
            now = null
            true
        }
        p.start()
        now = AudioNowPlaying(key, playing = true, durationMs = p.duration.toLong().takeIf { it > 0 }, pausedAtMs = 0L)
    }

    /** 当前位置：播放中读播放器，暂停读记下的位置，没在放返回 0 */
    fun positionMs(): Long {
        val cur = now ?: return 0L
        if (!cur.playing) return cur.pausedAtMs
        return try {
            player?.currentPosition?.toLong() ?: cur.pausedAtMs
        } catch (_: Exception) {
            cur.pausedAtMs
        }
    }

    /** 应用退到后台等场景：暂停但保留进度，回来可继续 */
    fun pause() {
        val cur = now ?: return
        if (!cur.playing) return
        val p = player ?: return
        try {
            p.pause()
            now = cur.copy(playing = false, pausedAtMs = p.currentPosition.toLong())
        } catch (_: Exception) {
            stop()
        }
    }

    /** 停止并回到无播放态（退出登录、笔记被删）；播放器实例保留复用 */
    fun stop() {
        preparedKey = null
        now = null
        try {
            player?.reset()
        } catch (_: Exception) {
        }
    }

    fun stopIfNote(noteId: String) {
        if (now?.let { audioPlaybackNoteId(it.key) } == noteId) stop()
    }

    /** 释放 MediaPlayer（Activity 销毁）；再次 toggle 会重建 */
    fun release() {
        stop()
        try {
            player?.release()
        } catch (_: Exception) {
        }
        player = null
    }
}
