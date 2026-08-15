package com.zalize.suinian.ui.components

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/** 录音时长上限：与 Web 麦克风一致（voice-recorder.tsx MAX_RECORD_SECONDS） */
const val MAX_RECORD_SECONDS = 10 * 60

/**
 * MediaRecorder 封装：录 m4a（AAC/MPEG-4，后端 Whisper 支持），
 * stop 返回音频字节，cancel 丢弃。与 Web 麦克风按钮同一转写管线。
 */
class VoiceRecorderController(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var output: File? = null

    val isRecording: Boolean get() = recorder != null

    /** 开始录音；失败时抛异常（如麦克风被占用） */
    fun start() {
        if (recorder != null) return
        val file = File.createTempFile("voice-", ".m4a", context.cacheDir)
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(64_000)
            r.setAudioSamplingRate(44_100)
            r.setMaxDuration(MAX_RECORD_SECONDS * 1000)
            r.setOutputFile(file.absolutePath)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            file.delete()
            throw IllegalStateException("无法开始录音：麦克风可能被其他应用占用", e)
        }
        recorder = r
        output = file
    }

    /** 停止录音并返回音频字节与文件名；录音过短/失败返回 null */
    fun stop(): Pair<ByteArray, String>? {
        val r = recorder ?: return null
        val file = output
        recorder = null
        output = null
        val ok = try {
            r.stop()
            true
        } catch (_: Exception) {
            false // 过短（<~1s）时 stop 抛 RuntimeException
        } finally {
            r.release()
        }
        val bytes = if (ok) file?.takeIf { it.length() > 0 }?.readBytes() else null
        file?.delete()
        if (bytes == null) return null
        val stamp = System.currentTimeMillis()
        return bytes to "voice-$stamp.m4a"
    }

    /** 取消录音并丢弃已录内容 */
    fun cancel() {
        val r = recorder ?: return
        recorder = null
        try {
            r.stop()
        } catch (_: Exception) {
        } finally {
            r.release()
        }
        output?.delete()
        output = null
    }
}
