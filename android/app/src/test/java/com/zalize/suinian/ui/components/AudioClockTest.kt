package com.zalize.suinian.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun arbiter_preempts_previous_owner_only() {
        val a = Any()
        val b = Any()
        var aPreempted = 0
        var bPreempted = 0
        AudioPlaybackArbiter.claim(a) { aPreempted++ }
        assertTrue(AudioPlaybackArbiter.isHeldBy(a))
        AudioPlaybackArbiter.claim(a) { aPreempted++ }
        assertEquals(0, aPreempted)
        AudioPlaybackArbiter.claim(b) { bPreempted++ }
        assertEquals(1, aPreempted)
        assertFalse(AudioPlaybackArbiter.isHeldBy(a))
        assertTrue(AudioPlaybackArbiter.isHeldBy(b))
        AudioPlaybackArbiter.release(a)
        assertTrue(AudioPlaybackArbiter.isHeldBy(b))
        AudioPlaybackArbiter.release(b)
        assertFalse(AudioPlaybackArbiter.isHeldBy(b))
        AudioPlaybackArbiter.claim(a) { aPreempted++ }
        assertEquals(0, bPreempted)
        AudioPlaybackArbiter.release(a)
    }
}
