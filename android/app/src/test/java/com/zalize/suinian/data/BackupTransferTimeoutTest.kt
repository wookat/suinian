package com.zalize.suinian.data

import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import com.zalize.suinian.data.api.BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS
import com.zalize.suinian.data.api.BACKUP_RESTORE_CALL_TIMEOUT_SECONDS
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * 备份下载 / 恢复上传是整包传输，整次调用不能被基础 client 的 30s callTimeout 掐断
 * （newBuilder() 会继承 callTimeout，只放宽 readTimeout 不起作用）；
 * 读响应体阶段的 IO 异常也要变成可读的 ApiException，而不是裸 "timeout"。
 */
class BackupTransferTimeoutTest {
    private val api = ApiClient("http://127.0.0.1:1", "t")

    @Test
    fun backup_clients_lift_the_30s_call_timeout() {
        assertEquals(BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS * 1000, api.backupDownloadClient.callTimeoutMillis.toLong())
        assertEquals(120_000, api.backupDownloadClient.readTimeoutMillis)
        assertEquals(BACKUP_RESTORE_CALL_TIMEOUT_SECONDS * 1000, api.backupRestoreClient.callTimeoutMillis.toLong())
        assertEquals(300_000, api.backupRestoreClient.readTimeoutMillis)
        assertEquals(300_000, api.backupRestoreClient.writeTimeoutMillis)
        assertTrue(BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS >= 600)
        assertTrue(BACKUP_RESTORE_CALL_TIMEOUT_SECONDS >= BACKUP_DOWNLOAD_CALL_TIMEOUT_SECONDS)
    }

    /** 服务端宣告 Content-Length 后只送一半就断开：读体阶段 IOException */
    private fun truncatingServer(): ServerSocket {
        val ss = ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))
        thread(isDaemon = true) {
            val s: Socket = try { ss.accept() } catch (_: Exception) { return@thread }
            val br = BufferedReader(InputStreamReader(s.getInputStream()))
            var len = 0
            val first = br.readLine().orEmpty()
            while (true) {
                val l = br.readLine() ?: break
                if (l.isEmpty()) break
                if (l.lowercase().startsWith("content-length:")) len = l.substringAfter(":").trim().toInt()
            }
            val buf = CharArray(8192)
            var remaining = len
            while (remaining > 0) { val n = br.read(buf, 0, minOf(buf.size, remaining)); if (n < 0) break; remaining -= n }
            val out = s.getOutputStream()
            val type = if (first.startsWith("POST")) "application/json" else "application/zip"
            out.write("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: 65536\r\nConnection: close\r\n\r\n".toByteArray())
            out.write(ByteArray(1024)); out.flush()
            s.close()
        }
        return ss
    }

    @Test
    fun download_body_truncated_is_readable_error() {
        val ss = truncatingServer()
        try {
            runBlocking { ApiClient("http://127.0.0.1:${ss.localPort}", "t").downloadBackup() }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message, e.message!!.contains("备份下载"))
            assertTrue(e.message, e.message!!.contains("重试"))
        } finally {
            ss.close()
        }
    }

    @Test
    fun restore_body_truncated_is_readable_error() {
        val ss = truncatingServer()
        try {
            runBlocking { ApiClient("http://127.0.0.1:${ss.localPort}", "t").restoreBackup(ByteArray(16), "backup.zip") }
            fail("expected ApiException")
        } catch (e: ApiException) {
            assertTrue(e.message, e.message!!.contains("恢复"))
            assertTrue(e.message, e.message!!.contains("自动跳过已导入"))
        } finally {
            ss.close()
        }
    }
}
