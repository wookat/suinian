package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** POST /api/notes/:id/retry-media：成功替换笔记（含 meta.media_status）；429 / 502 服务端文案原样给用户 */
class RetryMediaApiTest {

    private lateinit var server: ServerSocket
    private val lastRequest = AtomicReference<String>()
    @Volatile private var status = 200
    @Volatile private var body = ""

    /** 每个连接一次请求：读头 + 按 Content-Length 读体，回当前 status / body 后关连接 */
    @Before
    fun start() {
        server = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (_: Exception) { break }
                thread(isDaemon = true) {
                    s.use { sock ->
                        val input = sock.getInputStream()
                        val head = StringBuilder()
                        while (!head.endsWith("\r\n\r\n")) {
                            val b = input.read()
                            if (b < 0) return@use
                            head.append(b.toChar())
                        }
                        val lines = head.split("\r\n")
                        val auth = lines.firstOrNull { it.startsWith("Authorization:", ignoreCase = true) }
                            ?.substringAfter(":")?.trim()
                        val len = lines.firstOrNull { it.startsWith("Content-Length:", ignoreCase = true) }
                            ?.substringAfter(":")?.trim()?.toIntOrNull() ?: 0
                        repeat(len) { input.read() }
                        lastRequest.set("${lines[0].substringBeforeLast(" ")} auth=$auth")
                        val bytes = body.toByteArray()
                        val out = sock.getOutputStream()
                        out.write(
                            ("HTTP/1.1 $status X\r\nContent-Type: application/json\r\n" +
                                "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(),
                        )
                        out.write(bytes)
                        out.flush()
                    }
                }
            }
        }
    }

    @After
    fun stop() = server.close()

    private fun client() = ApiClient("http://127.0.0.1:${server.localPort}", "tok")

    @Test
    fun successReplacesNoteAndParsesMediaStatus() = runBlocking {
        status = 200
        body = """{"id":"n1","raw_type":"voice","content":"重新转写出来的正文","created_at":"2026-09-08T10:00:00Z",
            |"meta":{"media_status":"ok","raw_transcript":"重新转写出来的正文","transcript_suspect":false}}""".trimMargin()
        val note = client().retryMedia("n1")
        assertEquals("POST /api/notes/n1/retry-media auth=Bearer tok", lastRequest.get())
        assertEquals("重新转写出来的正文", note?.content)
        assertEquals("ok", note?.meta?.mediaStatus)
        assertEquals(false, note?.meta?.transcriptSuspect)
    }

    @Test
    fun failedMetaIsParsed() = runBlocking {
        status = 200
        body = """{"id":"n1","raw_type":"image","content":"【图片】文字提取失败，稍后可重发","created_at":"x",
            |"meta":{"media_status":"extract_failed","ocr_suspect":true}}""".trimMargin()
        val note = client().retryMedia("n1")
        assertEquals("extract_failed", note?.meta?.mediaStatus)
        assertEquals(true, note?.meta?.ocrSuspect)
    }

    @Test
    fun serverErrorTextIsSurfaced() = runBlocking {
        status = 502
        body = """{"error":"重试仍然失败，原件已保留，可稍后再试","retryable":true}"""
        try {
            client().retryMedia("n1")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals("重试仍然失败，原件已保留，可稍后再试", e.message)
        }
        status = 429
        body = """{"error":"重试太频繁了，请稍等一分钟再试","retryable":true}"""
        try {
            client().retryMedia("n1")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals("重试太频繁了，请稍等一分钟再试", e.message)
        }
        status = 409
        body = """{"error":"原件已不在，无法重试，请重新上传"}"""
        try {
            client().retryMedia("n1")
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message!!.contains("原件已不在"))
        }
    }
}
