package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import com.zalize.suinian.data.api.positiveHeaderLong
import com.zalize.suinian.ui.BackupDownloadState
import com.zalize.suinian.ui.backupDownloadLabel
import com.zalize.suinian.ui.backupDownloadPercent
import com.zalize.suinian.ui.backupDownloadStep
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * 备份下载是整包传输（≤200MB，服务端流式打包、无 Content-Length）：要边收边写、报已接收字节，
 * 且取消协程时要真正中断接收（阻塞式 execute() + body.bytes() 不响应协程取消，取消后整包仍会在 IO 线程收完再丢掉）。
 */
class BackupDownloadProgressCancelTest {

    /** 每 [pauseMs] 送一块 [chunk] 字节，共 [chunks] 块；chunked 编码（与 Cloudflare 流式响应一致）或宣告 Content-Length */
    private class SlowServer(
        private val chunk: Int,
        private val chunks: Int,
        private val pauseMs: Long,
        private val chunked: Boolean = true,
        private val status: String = "200 OK",
        private val fileName: String = "suinian-backup-2026-09-08.zip",
        /** 非空时加 X-Suinian-Backup-Estimate 头（#459 服务端预估总长） */
        private val estimateHeader: String? = null,
    ) {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val sent = AtomicLong(0)
        val finished = CountDownLatch(1)
        val writeFailed = AtomicBoolean(false)

        init {
            thread(isDaemon = true) {
                val s: Socket = try { ss.accept() } catch (_: Exception) { return@thread }
                try {
                    val input = s.getInputStream()
                    val sb = StringBuilder()
                    while (true) {
                        val c = input.read()
                        if (c < 0) break
                        sb.append(c.toChar())
                        if (sb.endsWith("\r\n\r\n")) break
                    }
                    val out = s.getOutputStream()
                    val framing = if (chunked) "Transfer-Encoding: chunked" else "Content-Length: ${chunk.toLong() * chunks}"
                    val estimate = if (estimateHeader == null) "" else "X-Suinian-Backup-Estimate: $estimateHeader\r\n"
                    out.write(
                        ("HTTP/1.1 $status\r\nContent-Type: application/zip\r\n" +
                            "Content-Disposition: attachment; filename=\"$fileName\"\r\n$framing\r\n${estimate}Connection: close\r\n\r\n").toByteArray()
                    )
                    val block = ByteArray(chunk) { (it % 251).toByte() }
                    for (i in 0 until chunks) {
                        if (chunked) out.write("${chunk.toString(16)}\r\n".toByteArray())
                        out.write(block)
                        if (chunked) out.write("\r\n".toByteArray())
                        out.flush()
                        sent.addAndGet(chunk.toLong())
                        if (pauseMs > 0) java.lang.Thread.sleep(pauseMs)
                    }
                    if (chunked) out.write("0\r\n\r\n".toByteArray())
                    out.flush()
                } catch (_: Exception) {
                    writeFailed.set(true)
                } finally {
                    try { s.close() } catch (_: Exception) {}
                    finished.countDown()
                }
            }
        }

        fun api() = ApiClient("http://127.0.0.1:${ss.localPort}", "t")
        fun close() = ss.close()
    }

    /** 记录 open() 是否被调、写入了多少字节、是否被 close */
    private class Sink : OutputStream() {
        val bytes = ByteArrayOutputStream()
        var opened = 0
        var closed = false
        override fun write(b: Int) { bytes.write(b) }
        override fun write(b: ByteArray, off: Int, len: Int) { bytes.write(b, off, len) }
        override fun close() { closed = true }
    }

    @Test
    fun streams_chunked_body_into_sink_and_reports_received_bytes_with_unknown_total() {
        val server = SlowServer(chunk = 64 * 1024, chunks = 8, pauseMs = 0)
        val sink = Sink()
        val progress = mutableListOf<Pair<Long, Long>>()
        try {
            val name = runBlocking {
                server.api().downloadBackup(onProgress = { r, t, _ -> progress += r to t }) { fileName ->
                    sink.opened++
                    assertEquals("suinian-backup-2026-09-08.zip", fileName)
                    sink
                }
            }
            assertEquals("suinian-backup-2026-09-08.zip", name)
            assertEquals(1, sink.opened)
            assertTrue(sink.closed)
            assertEquals(8L * 64 * 1024, sink.bytes.size().toLong())
            assertTrue(progress.isNotEmpty())
            // 服务端流式 zip 没有 Content-Length：total 一律 -1，received 单调递增到全量
            assertTrue(progress.all { it.second == -1L })
            assertEquals(progress.map { it.first }, progress.map { it.first }.sorted())
            assertEquals(8L * 64 * 1024, progress.last().first)
        } finally {
            server.close()
        }
    }

    @Test
    fun known_content_length_is_reported_as_total() {
        val server = SlowServer(chunk = 32 * 1024, chunks = 4, pauseMs = 0, chunked = false)
        val progress = mutableListOf<Pair<Long, Long>>()
        try {
            runBlocking { server.api().downloadBackup(onProgress = { r, t, _ -> progress += r to t }) { Sink() } }
            assertTrue(progress.all { it.second == 4L * 32 * 1024 })
            assertEquals(4L * 32 * 1024, progress.last().first)
        } finally {
            server.close()
        }
    }

    private data class P(val received: Long, val total: Long, val estimate: Long)

    private fun download(server: SlowServer): List<P> {
        val progress = mutableListOf<P>()
        runBlocking { server.api().downloadBackup(onProgress = { r, t, e -> progress += P(r, t, e) }) { Sink() } }
        return progress
    }

    @Test
    fun estimate_header_is_reported_alongside_unknown_total() {
        // 全部原件在位：预估 = 实际（#459 本机实录 5402763 = 5402763）
        val actual = 8L * 64 * 1024
        val server = SlowServer(chunk = 64 * 1024, chunks = 8, pauseMs = 0, estimateHeader = actual.toString())
        try {
            val progress = download(server)
            assertTrue(progress.all { it.total == -1L && it.estimate == actual })
            progress.firstOrNull { it.received in 1 until actual }?.let { mid ->
                val state = BackupDownloadState.Running(mid.received, mid.total, mid.estimate)
                val percent = backupDownloadPercent(state)!!
                assertTrue(percent in 0..99)
                assertEquals("下载中 ${"%.1fMB".format(mid.received / 1048576.0)} / 约 0.5MB（约 $percent%）", backupDownloadLabel(state))
            }
            // 收完前不显示 100%
            val last = progress.last()
            assertEquals(actual, last.received)
            assertEquals(99, backupDownloadPercent(BackupDownloadState.Running(last.received, last.total, last.estimate)))
        } finally {
            server.close()
        }
    }

    @Test
    fun estimate_larger_than_actual_still_completes_without_error() {
        // R2 缺对象被跳过：实际 < 预估，不得报「中断」
        val server = SlowServer(chunk = 64 * 1024, chunks = 4, pauseMs = 0, estimateHeader = (10L * 64 * 1024).toString())
        try {
            val progress = download(server)
            assertEquals(4L * 64 * 1024, progress.last().received)
            assertEquals(40, backupDownloadPercent(BackupDownloadState.Running(progress.last().received, -1, progress.last().estimate)))
        } finally {
            server.close()
        }
    }

    @Test
    fun received_beyond_estimate_falls_back_to_bytes_only() {
        // attachments.size 未知：实际 > 预估，超出后不显示百分比也不报错
        val estimate = 2L * 64 * 1024
        val server = SlowServer(chunk = 64 * 1024, chunks = 4, pauseMs = 0, estimateHeader = estimate.toString())
        try {
            val progress = download(server)
            assertEquals(4L * 64 * 1024, progress.last().received)
            val over = progress.filter { it.received > estimate }
            assertTrue(over.isNotEmpty())
            for (p in over) {
                val s = BackupDownloadState.Running(p.received, p.total, p.estimate)
                assertNull(backupDownloadPercent(s))
                val label = backupDownloadLabel(s)
                assertTrue(label, label.contains("已接收") && label.contains("预估约 0.1MB") && !label.contains("%"))
            }
            // 跨过预估时归约键必变（否则 UI 停在「约 99%」）
            assertTrue(backupDownloadStep(estimate, -1, estimate) != backupDownloadStep(estimate + 1, -1, estimate))
        } finally {
            server.close()
        }
    }

    @Test
    fun exact_content_length_wins_over_estimate_header() {
        val server = SlowServer(chunk = 32 * 1024, chunks = 4, pauseMs = 0, chunked = false, estimateHeader = "999999999")
        try {
            val progress = download(server)
            assertTrue(progress.all { it.total == 4L * 32 * 1024 && it.estimate == -1L })
        } finally {
            server.close()
        }
    }

    @Test
    fun malformed_estimate_header_is_ignored() {
        val server = SlowServer(chunk = 16 * 1024, chunks = 2, pauseMs = 0, estimateHeader = "abc")
        try {
            assertTrue(download(server).all { it.total == -1L && it.estimate == -1L })
        } finally {
            server.close()
        }
        assertEquals(-1L, positiveHeaderLong(null))
        assertEquals(-1L, positiveHeaderLong(""))
        assertEquals(-1L, positiveHeaderLong("0"))
        assertEquals(-1L, positiveHeaderLong("-5"))
        assertEquals(-1L, positiveHeaderLong("1e3"))
        assertEquals(-1L, positiveHeaderLong("12.5"))
        assertEquals(-1L, positiveHeaderLong("99999999999999999999"))
        assertEquals(123L, positiveHeaderLong(" 123 "))
    }

    @Test
    fun cancel_interrupts_receiving_promptly_and_stops_server_side_stream() {
        // 每 40ms 送 64KB，共 4MB（≈2.5s 送完）；400ms 时取消
        val server = SlowServer(chunk = 64 * 1024, chunks = 64, pauseMs = 40)
        val sink = Sink()
        try {
            val t0 = System.nanoTime()
            var cancelled = false
            var apiError: ApiException? = null
            runBlocking {
                val job = launch(Dispatchers.IO) {
                    try {
                        server.api().downloadBackup { sink }
                    } catch (e: CancellationException) {
                        cancelled = true
                        throw e
                    } catch (e: ApiException) {
                        apiError = e
                    }
                }
                delay(400)
                job.cancel()
                job.join()
            }
            val joinMs = (System.nanoTime() - t0) / 1_000_000
            assertTrue("join took ${joinMs}ms", joinMs < 1500)
            // 取消要以 CancellationException 冒泡（调用方按「已取消」处理），不能伪装成网络错误
            assertTrue("expected CancellationException, got $apiError", cancelled)
            assertNull(apiError)
            assertTrue("sink should be closed so the caller can delete the partial file", sink.closed)
            assertTrue("received ${sink.bytes.size()} should be a partial body", sink.bytes.size() < 64 * 64 * 1024)
            // 底层 Call 已 cancel：服务端很快写失败或提前结束，而不是把 4MB 送完
            assertTrue(server.finished.await(3, TimeUnit.SECONDS))
            assertTrue("server sent ${server.sent.get()} bytes", server.sent.get() < 64L * 64 * 1024)
        } finally {
            server.close()
        }
    }

    @Test
    fun http_error_does_not_open_the_sink() {
        val server = SlowServer(chunk = 16, chunks = 1, pauseMs = 0, status = "403 Forbidden")
        var opened = false
        try {
            runBlocking { server.api().downloadBackup { opened = true; Sink() } }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertFalse("4xx must not create a download file", opened)
        } finally {
            server.close()
        }
    }

    @Test
    fun label_and_percent_handle_unknown_total() {
        val unknown = BackupDownloadState.Running(received = 3L * 1024 * 1024 + 512 * 1024, total = -1)
        assertNull(backupDownloadPercent(unknown))
        assertTrue(backupDownloadLabel(unknown).contains("已接收 3.5MB"))
        assertTrue(backupDownloadLabel(unknown).contains("可离开此页"))

        val known = BackupDownloadState.Running(received = 25L * 1024 * 1024, total = 100L * 1024 * 1024)
        assertEquals(25, backupDownloadPercent(known))
        assertEquals("下载中 25.0MB / 100.0MB（25%）", backupDownloadLabel(known))

        // 未知总长按整 MB 归约、已知总长按百分比归约：同一步内不重组
        assertEquals(backupDownloadStep(1024 * 1024 + 1, -1), backupDownloadStep(2 * 1024 * 1024 - 1, -1))
        assertTrue(backupDownloadStep(2 * 1024 * 1024, -1) > backupDownloadStep(2 * 1024 * 1024 - 1, -1))
        assertEquals(backupDownloadStep(10, 1000), backupDownloadStep(19, 1000))
        assertTrue(backupDownloadStep(20, 1000) > backupDownloadStep(19, 1000))
    }

    @Test
    fun label_and_percent_handle_estimate() {
        val est = 100L * 1024 * 1024
        val approx = BackupDownloadState.Running(received = 25L * 1024 * 1024, total = -1, estimate = est)
        assertEquals(25, backupDownloadPercent(approx))
        assertEquals("下载中 25.0MB / 约 100.0MB（约 25%）", backupDownloadLabel(approx))
        // 预估封顶 99：刚好收满预估也不显 100
        assertEquals(99, backupDownloadPercent(BackupDownloadState.Running(est, -1, est)))
        // 超出预估：不显百分比，文案仍说明预估
        val over = BackupDownloadState.Running(est + 1, -1, est)
        assertNull(backupDownloadPercent(over))
        assertTrue(backupDownloadLabel(over).contains("预估约 100.0MB"))
        // 精确总长优先于预估
        val exact = BackupDownloadState.Running(50, 100, 1000)
        assertEquals(50, backupDownloadPercent(exact))
        assertFalse(backupDownloadLabel(exact).contains("约"))
        // 预估态按百分点归约
        assertEquals(backupDownloadStep(10, -1, 1000), backupDownloadStep(19, -1, 1000))
        assertTrue(backupDownloadStep(20, -1, 1000) > backupDownloadStep(19, -1, 1000))
    }
}
