package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
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
                    out.write(
                        ("HTTP/1.1 $status\r\nContent-Type: application/zip\r\n" +
                            "Content-Disposition: attachment; filename=\"$fileName\"\r\n$framing\r\nConnection: close\r\n\r\n").toByteArray()
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
                server.api().downloadBackup(onProgress = { r, t -> progress += r to t }) { fileName ->
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
            runBlocking { server.api().downloadBackup(onProgress = { r, t -> progress += r to t }) { Sink() } }
            assertTrue(progress.all { it.second == 4L * 32 * 1024 })
            assertEquals(4L * 32 * 1024, progress.last().first)
        } finally {
            server.close()
        }
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
}
