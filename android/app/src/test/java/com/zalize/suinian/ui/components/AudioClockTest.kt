package com.zalize.suinian.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AudioClockTest {
    @Test
    fun clock_rounds_to_seconds_and_carries_hours() {
        assertEquals("0:00", formatAudioClock(0))
        assertEquals("0:00", formatAudioClock(499))
        assertEquals("0:01", formatAudioClock(500))
        assertEquals("0:07", formatAudioClock(7_300))
        assertEquals("1:05", formatAudioClock(65_000))
        assertEquals("12:03", formatAudioClock(723_400))
        assertEquals("1:00:00", formatAudioClock(3_600_000))
        assertEquals("2:03:09", formatAudioClock(7_389_000))
        assertNull(formatAudioClock(null))
        assertNull(formatAudioClock(-1))
    }

    @Test
    fun progress_is_null_without_duration_and_clamped() {
        assertNull(audioProgress(1000, null))
        assertNull(audioProgress(1000, 0))
        assertEquals(0.5f, audioProgress(5_000, 10_000)!!, 0.0001f)
        assertEquals(1f, audioProgress(12_000, 10_000)!!, 0f)
        assertEquals(0f, audioProgress(-3, 10_000)!!, 0f)
    }

    @Test
    fun label_shows_duration_before_play_and_position_while_playing() {
        assertEquals("语音 0:12", audioClockLabel(playing = false, inProgress = false, position = "0:00", total = "0:12"))
        assertEquals("播放原始语音", audioClockLabel(playing = false, inProgress = false, position = null, total = null))
        assertEquals("播放中 0:03 / 0:12", audioClockLabel(playing = true, inProgress = true, position = "0:03", total = "0:12"))
        assertEquals("已暂停 0:03 / 0:12", audioClockLabel(playing = false, inProgress = true, position = "0:03", total = "0:12"))
        assertEquals("播放中 0:03", audioClockLabel(playing = true, inProgress = true, position = "0:03", total = null))
    }

    @Test
    fun download_name_prefers_server_name_and_adds_extension_from_mime() {
        assertEquals("voice.amr", audioDownloadName("voice.amr", "audio/amr", "n1"))
        assertEquals("会议录音.m4a", audioDownloadName("会议录音.m4a", "audio/mp4", "n1"))
        assertEquals("voice.amr", audioDownloadName("voice", "audio/amr", "n1"))
        assertEquals("recording.webm", audioDownloadName("recording", "audio/webm;codecs=opus", "n1"))
        assertEquals("voice-0123abcd.m4a", audioDownloadName("", "audio/x-m4a", "0123abcd-ffff"))
        assertEquals("voice-0123abcd", audioDownloadName("  ", null, "0123abcd-ffff"))
        assertEquals("voice-0123abcd", audioDownloadName("", "audio/x-unknown", "0123abcd-ffff"))
        // 「1.2.3」这类点不是扩展名分隔时按 mime 补
        assertEquals("v1.2.3 录音.amr", audioDownloadName("v1.2.3 录音", "audio/amr", "n1"))
    }

    @Test
    fun image_download_name_uses_image_mime_and_image_prefix() {
        assertEquals("IMG_0001.jpg", attachmentDownloadName("IMG_0001.jpg", "image/jpeg", "n1", "image"))
        assertEquals("photo.jpg", attachmentDownloadName("photo", "image/jpeg", "n1", "image"))
        assertEquals("白板.png", attachmentDownloadName("白板", "image/png", "n1", "image"))
        assertEquals("image-0123abcd.webp", attachmentDownloadName("", "image/webp", "0123abcd-ffff", "image"))
        assertEquals("image-0123abcd", attachmentDownloadName("", "image/x-unknown", "0123abcd-ffff", "image"))
        assertEquals("voice-0123abcd.amr", attachmentDownloadName("", "audio/amr", "0123abcd-ffff", "voice"))
    }

    @Test
    fun share_title_follows_note_raw_type() {
        assertEquals("分享原图", attachmentShareTitle("image"))
        assertEquals("分享语音", attachmentShareTitle("voice"))
        assertEquals("分享原件", attachmentShareTitle("file"))
        assertEquals("分享原件", attachmentShareTitle(null))
    }

    @Test
    fun unplayable_hint_only_promises_exits_that_exist() {
        assertEquals("，可分享或下载原件用其他应用打开", audioUnplayableHint(canDownload = true, canShare = true))
        assertEquals("，可分享给其他应用打开", audioUnplayableHint(canDownload = false, canShare = true))
        assertEquals("，可下载原件用其他应用打开", audioUnplayableHint(canDownload = true, canShare = false))
        assertEquals("", audioUnplayableHint(canDownload = false, canShare = false))
    }

    @Test
    fun playback_key_round_trips_note_id() {
        val key = audioPlaybackKey("note-1", "att/with/slash")
        assertEquals("note-1", audioPlaybackNoteId(key))
        assertEquals("note-1/att/with/slash", key)
    }
}
