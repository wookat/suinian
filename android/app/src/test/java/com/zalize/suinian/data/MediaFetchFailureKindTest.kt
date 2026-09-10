package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import com.zalize.suinian.ui.components.mediaLoadFailureAutoRetries
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * 卡片附件拉取失败要能区分「换网 / 刷新后值得重拉」与「重拉也不会变」：
 * 真实 ApiClient 对本机 socket 的 404 / 503 / 拒连 / 传输中断，ApiException 的 status / network 必须如实。
 */
class MediaFetchFailureKindTest {

    private fun serve(response: String, closeAfterHeader: Boolean = false): ApiClient {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            val s = try { ss.accept() } catch (_: Exception) { return@thread }
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
                out.write(response.toByteArray())
                out.flush()
                if (closeAfterHeader) out.write(ByteArray(16))
            } catch (_: Exception) {
            } finally {
                try { s.close() } catch (_: Exception) {}
                try { ss.close() } catch (_: Exception) {}
            }
        }
        return ApiClient("http://127.0.0.1:${ss.localPort}", "t")
    }

    private fun fetchFailure(api: ApiClient): ApiException = try {
        runBlocking { api.fetchNoteMedia("n1", "a1") }
        fail("expected ApiException")
        throw IllegalStateException()
    } catch (e: ApiException) {
        e
    }

    @Test
    fun not_found_keeps_status_and_is_not_auto_retried() {
        val body = """{"error":"attachment missing"}"""
        val e = fetchFailure(
            serve("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body")
        )
        assertEquals(404, e.status)
        assertFalse(e.network)
        assertEquals("attachment missing", e.message)
        assertFalse(mediaLoadFailureAutoRetries(e))
    }

    @Test
    fun unauthorized_default_text_keeps_status_and_is_not_auto_retried() {
        val body = """{"error":"unauthorized"}"""
        val e = fetchFailure(
            serve("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body")
        )
        assertEquals(401, e.status)
        assertEquals("Token 无效或没有权限，请在设置中检查 API Token", e.message)
        assertFalse(mediaLoadFailureAutoRetries(e))
    }

    @Test
    fun server_error_is_auto_retried() {
        val e = fetchFailure(
            serve("HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndown")
        )
        assertEquals(503, e.status)
        assertEquals("服务器开小差了（503），请稍后重试", e.message)
        assertTrue(mediaLoadFailureAutoRetries(e))
    }

    @Test
    fun connection_refused_is_network_failure_and_auto_retried() {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val port = ss.localPort
        ss.close()
        val e = fetchFailure(ApiClient("http://127.0.0.1:$port", "t"))
        assertTrue(e.network)
        assertEquals(null, e.status)
        assertEquals("网络连接失败，请检查网络后重试", e.message)
        assertTrue(mediaLoadFailureAutoRetries(e))
    }

    @Test
    fun truncated_body_is_network_failure_and_auto_retried() {
        val e = fetchFailure(
            serve(
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n",
                closeAfterHeader = true,
            )
        )
        assertTrue(e.network)
        assertEquals("附件加载中断，请检查网络后重试", e.message)
        assertTrue(mediaLoadFailureAutoRetries(e))
    }
}
