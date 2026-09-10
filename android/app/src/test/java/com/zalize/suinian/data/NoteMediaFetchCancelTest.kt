package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * 卡片内联的图片 / 语音原件由 LazyColumn item 的 LaunchedEffect 拉取，item 滑出屏幕即取消协程：
 * 拉取必须真正中断（阻塞式 execute()+bytes() 不响应取消，快速滑过一屏图片会让每张原图都在 IO 线程收完再丢掉、且不进缓存）。
 */
class NoteMediaFetchCancelTest {

    /** 每 [pauseMs] 送一块 [chunk] 字节，共 [chunks] 块，带 Content-Length（与 /api/notes/:id/file 回源 R2 一致） */
    private class SlowServer(
        private val chunk: Int,
        private val chunks: Int,
        private val pauseMs: Long,
        /** 宣告 chunks 块但只送这么多块就断开（模拟中途断网） */
        private val sendOnly: Int = chunks,
    ) {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val sent = AtomicLong(0)
        val finished = CountDownLatch(1)
        val requestLine = StringBuilder()

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
                    requestLine.append(sb.lineSequence().first())
                    val out = s.getOutputStream()
                    out.write(
                        ("HTTP/1.1 200 OK\r\nContent-Type: audio/amr\r\nContent-Length: ${chunk.toLong() * chunks}\r\n" +
                            "Connection: close\r\n\r\n").toByteArray()
                    )
                    val block = ByteArray(chunk) { (it % 251).toByte() }
                    for (i in 0 until sendOnly) {
                        out.write(block)
                        out.flush()
                        sent.addAndGet(chunk.toLong())
                        if (pauseMs > 0) java.lang.Thread.sleep(pauseMs)
                    }
                } catch (_: Exception) {
                } finally {
                    try { s.close() } catch (_: Exception) {}
                    finished.countDown()
                }
            }
        }

        fun api() = ApiClient("http://127.0.0.1:${ss.localPort}", "t")
        fun close() = ss.close()
    }

    @Test
    fun full_download_returns_bytes_and_mime() {
        val server = SlowServer(chunk = 64 * 1024, chunks = 4, pauseMs = 0)
        try {
            val (bytes, mime) = runBlocking { server.api().fetchNoteMedia("n1", "a1") }
            assertEquals(4 * 64 * 1024, bytes.size)
            assertEquals("audio/amr", mime)
            assertTrue(server.requestLine.toString(), server.requestLine.contains("/api/notes/n1/file?inline=1&att=a1"))
        } finally {
            server.close()
        }
    }

    @Test
    fun mid_stream_disconnect_is_a_readable_error_not_a_cancellation() {
        val server = SlowServer(chunk = 64 * 1024, chunks = 4, pauseMs = 0, sendOnly = 2)
        try {
            try {
                runBlocking { server.api().fetchNoteMedia("n1", "a1") }
                fail("truncated body must fail")
            } catch (e: ApiException) {
                assertEquals("附件加载中断，请检查网络后重试", e.message)
            }
        } finally {
            server.close()
        }
    }

    @Test
    fun cancelling_the_coroutine_stops_the_transfer_promptly() {
        // 64KB / 40ms × 64 = 4MB，约 2.6s 才送完；400ms 时取消
        val server = SlowServer(chunk = 64 * 1024, chunks = 64, pauseMs = 40)
        try {
            val joinMs = runBlocking {
                val job = launch(Dispatchers.Default) {
                    try {
                        server.api().fetchNoteMedia("n1", "a1")
                        fail("should have been cancelled")
                    } catch (_: CancellationException) {
                    } catch (e: ApiException) {
                        fail("cancellation must surface as CancellationException, got ApiException: ${e.message}")
                    }
                }
                delay(400)
                val t0 = System.nanoTime()
                job.cancelAndJoin()
                (System.nanoTime() - t0) / 1_000_000
            }
            assertTrue("服务端应因客户端断开而停发", server.finished.await(3, TimeUnit.SECONDS))
            val sent = server.sent.get()
            assertTrue("取消后应立刻返回，实际 join 耗时 ${joinMs}ms、服务端送出 $sent 字节", joinMs < 1000)
            assertTrue("取消后服务端不该继续送完 4MB，实际送出 $sent", sent < 3L * 1024 * 1024)
        } finally {
            server.close()
        }
    }
}
