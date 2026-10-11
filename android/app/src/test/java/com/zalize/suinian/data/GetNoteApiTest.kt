package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * 搜索命中 / 问答引用回传的敏感卡 content 是服务端占位串（content_withheld）：
 * 点开要经 GET /api/notes/:id 取回原文。真实 ApiClient 对本机 socket 的 200 / 404 / 401 响应口径。
 */
class GetNoteApiTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun serve(response: String, captured: StringBuilder? = null): ApiClient {
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
                captured?.append(sb)
                val out = s.getOutputStream()
                out.write(response.toByteArray())
                out.flush()
            } catch (_: Exception) {
            } finally {
                try { s.close() } catch (_: Exception) {}
                try { ss.close() } catch (_: Exception) {}
            }
        }
        return ApiClient("http://127.0.0.1:${ss.localPort}", "tok")
    }

    private fun ok(body: String) =
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body"

    @Test
    fun search_hit_placeholder_card_deserializes_withheld_flags() {
        // 服务端 GET /api/notes?q= 对敏感命中的真实形状（R326）：content 是占位串、content_withheld=true
        val page = json.decodeFromString(
            NotesPage.serializer(),
            """{"notes":[{"id":"9b5a28d9","content":"[敏感笔记：正文已加密保护，点开卡片查看原文]","is_sensitive":true,"content_withheld":true,"created_at":"2026-09-10T00:00:00Z"}]}""",
        )
        val n = page.notes.single()
        assertTrue(n.isSensitive)
        assertEquals(true, n.contentWithheld)
        assertNull(n.guarded)
    }

    @Test
    fun ask_guarded_ref_card_and_vision_meta_deserialize() {
        val guarded = json.decodeFromString(
            Note.serializer(),
            """{"id":"g1","content":"〔含口令 / 密钥一类内容的笔记：问答引用卡不回传原文，点开卡片查看〕","is_sensitive":false,"content_withheld":true,"guarded":true,"meta":null,"created_at":"2026-09-10T00:00:00Z"}""",
        )
        assertFalse(guarded.isSensitive)
        assertEquals(true, guarded.contentWithheld)
        assertEquals(true, guarded.guarded)
        val vision = json.decodeFromString(
            Note.serializer(),
            """{"id":"v1","content":"[加密内容]","is_sensitive":1,"meta":{"vision_sensitive":true,"import_fp":"x"},"created_at":"2026-09-10T00:00:00Z"}""",
        )
        assertTrue(vision.isSensitive)
        assertEquals(true, vision.meta?.visionSensitive)
        assertNull(vision.meta?.needsRetriage)
    }

    @Test
    fun get_note_returns_decrypted_note_from_wrapped_body() {
        val captured = StringBuilder()
        val body = """{"note":{"id":"9b5a28d9","content":"家里 wifi 密码：jia-home-2026-Qz","is_sensitive":true,"tags":["wifi"],"created_at":"2026-09-10T00:00:00Z"}}"""
        val n = runBlocking { serve(ok(body), captured).getNote("9b5a28d9") }!!
        assertTrue(captured.startsWith("GET /api/notes/9b5a28d9 HTTP/1.1"))
        assertTrue(captured.contains("Authorization: Bearer tok"))
        assertEquals("家里 wifi 密码：jia-home-2026-Qz", n.content)
        assertTrue(n.isSensitive)
        assertNull(n.contentWithheld)
        assertEquals(listOf("wifi"), n.tags)
    }

    @Test
    fun get_note_not_found_returns_null() {
        val body = """{"error":"not found"}"""
        val n = runBlocking {
            serve("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body").getNote("gone")
        }
        assertNull(n)
    }

    @Test
    fun get_note_unauthorized_throws_with_status() {
        val body = """{"error":"unauthorized"}"""
        try {
            runBlocking {
                serve("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body").getNote("n1")
            }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
            assertEquals("Token 无效或没有权限，请在设置中检查 API Token", e.message)
        }
    }

    @Test
    fun get_note_connection_refused_is_network_failure() {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        val port = ss.localPort
        ss.close()
        try {
            runBlocking { ApiClient("http://127.0.0.1:$port", "t").getNote("n1") }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.network)
            assertNull(e.status)
        }
    }
}
