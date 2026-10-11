package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * 恢复上传是整包传输（≤200MB）：要能报上传进度，且取消协程时要真正中断上传
 * （阻塞式 execute() 不响应协程取消，取消后上传会在 IO 线程继续跑完）。
 */
class BackupRestoreProgressCancelTest {

    private class SlowServer(private val chunk: Int, private val pauseMs: Long, private val respond: Boolean) {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val received = AtomicLong(0)
        val declared = AtomicLong(-1)
        val finished = CountDownLatch(1)
        var sawEof = false

        init {
            thread(isDaemon = true) {
                val s: Socket = try { ss.accept() } catch (_: Exception) { return@thread }
                try {
                    val input = s.getInputStream()
                    val br = BufferedReader(InputStreamReader(input, Charsets.ISO_8859_1))
                    var len = 0L
                    while (true) {
                        val l = br.readLine() ?: break
                        if (l.isEmpty()) break
                        if (l.lowercase().startsWith("content-length:")) len = l.substringAfter(":").trim().toLong()
                    }
                    declared.set(len)
                    val buf = CharArray(chunk)
                    var remaining = len
                    while (remaining > 0) {
                        val n = br.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                        if (n < 0) { sawEof = true; break }
                        remaining -= n
                        received.addAndGet(n.toLong())
                        if (pauseMs > 0) java.lang.Thread.sleep(pauseMs)
                    }
                    if (respond && remaining == 0L) {
                        val body = """{"notes_total":1,"notes_imported":1}"""
                        s.getOutputStream().write(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray()
                        )
                        s.getOutputStream().flush()
                    }
                } catch (_: Exception) {
                    sawEof = true
                } finally {
                    try { s.close() } catch (_: Exception) {}
                    finished.countDown()
                }
            }
        }
    }

    @Test
    fun restore_reports_monotonic_upload_progress_up_to_total() {
        val server = SlowServer(chunk = 64 * 1024, pauseMs = 0, respond = true)
        val sizes = mutableListOf<Pair<Long, Long>>()
        try {
            val stats = runBlocking {
                ApiClient("http://127.0.0.1:${server.ss.localPort}", "t")
                    .restoreBackup(ByteArray(512 * 1024), "backup.zip") { sent, total ->
                        synchronized(sizes) { sizes.add(sent to total) }
                    }
            }
            assertEquals(1, stats.notesImported)
            assertTrue(server.finished.await(5, TimeUnit.SECONDS))
            val snapshot = synchronized(sizes) { sizes.toList() }
            assertTrue("progress callbacks expected", snapshot.size >= 2)
            val total = snapshot.first().second
            assertEquals("total = multipart content-length", server.declared.get(), total)
            assertTrue("total covers the zip bytes", total > 512 * 1024)
            snapshot.zipWithNext().forEach { (a, b) -> assertTrue("monotonic", b.first >= a.first) }
            assertEquals(total, snapshot.last().first)
            assertTrue(snapshot.all { it.first <= total })
        } finally {
            server.ss.close()
        }
    }

    @Test
    fun cancelling_restore_aborts_the_upload_promptly() {
        // 服务端每 40ms 才读 64KB：4MB 包全部读完需 ≥2.5s；400ms 时取消
        val server = SlowServer(chunk = 64 * 1024, pauseMs = 40, respond = true)
        try {
            val api = ApiClient("http://127.0.0.1:${server.ss.localPort}", "t")
            val startedAt = System.nanoTime()
            var joinedAfterMs = 0L
            runBlocking {
                val job = launch(Dispatchers.IO) {
                    try { api.restoreBackup(ByteArray(4 * 1024 * 1024), "backup.zip") } catch (_: Exception) {}
                }
                delay(400)
                job.cancel()
                job.join()
                joinedAfterMs = (System.nanoTime() - startedAt) / 1_000_000
            }
            assertTrue("join took ${joinedAfterMs}ms", joinedAfterMs < 1500)
            // 内核 socket 缓冲里已到的字节服务端仍会慢慢读完，但必须在读满 Content-Length 前碰到 EOF
            assertTrue("server should see the upload end", server.finished.await(8, TimeUnit.SECONDS))
            assertTrue("server should hit EOF before Content-Length", server.sawEof)
            assertTrue("upload should be aborted, got ${server.received.get()} of ${server.declared.get()}", server.received.get() < server.declared.get())
        } finally {
            server.ss.close()
        }
    }
}
