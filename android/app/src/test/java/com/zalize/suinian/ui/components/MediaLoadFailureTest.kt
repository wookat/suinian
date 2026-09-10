package com.zalize.suinian.ui.components

import com.zalize.suinian.data.api.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** 附件加载失败态显示的原因：只透出已写成可读文案的 ApiException，系统异常原文不给用户 */
class MediaLoadFailureTest {

    @Test
    fun api_exception_message_is_shown_verbatim() {
        assertEquals(
            "网络连接失败，请检查网络后重试",
            mediaLoadFailureReason(ApiException("网络连接失败，请检查网络后重试", IOException("connect timed out"))),
        )
        assertEquals("内容不存在或已被删除", mediaLoadFailureReason(ApiException("内容不存在或已被删除")))
        assertEquals(
            "语音无法写入本机缓存，请清理存储空间后重试",
            mediaLoadFailureReason(ApiException("语音无法写入本机缓存，请清理存储空间后重试")),
        )
    }

    @Test
    fun only_network_and_server_errors_auto_retry() {
        assertTrue(mediaLoadFailureAutoRetries(ApiException("网络连接失败，请检查网络后重试", network = true)))
        assertTrue(mediaLoadFailureAutoRetries(ApiException("附件加载中断，请检查网络后重试", network = true)))
        assertTrue(mediaLoadFailureAutoRetries(ApiException("服务器开小差了（502），请稍后重试", status = 502)))
        assertFalse(mediaLoadFailureAutoRetries(ApiException("内容不存在或已被删除", status = 404)))
        assertFalse(mediaLoadFailureAutoRetries(ApiException("Token 无效或没有权限，请在设置中检查 API Token", status = 401)))
        assertFalse(mediaLoadFailureAutoRetries(ApiException("请求太频繁", status = 429)))
        assertFalse(mediaLoadFailureAutoRetries(ApiException("语音无法写入本机缓存，请清理存储空间后重试")))
        assertFalse(mediaLoadFailureAutoRetries(IOException("ENOSPC")))
        assertFalse(mediaLoadFailureAutoRetries(IllegalStateException("Mock 模式下不可用")))
    }

    @Test
    fun raw_system_exceptions_are_not_shown() {
        assertNull(mediaLoadFailureReason(IOException("ENOSPC (No space left on device)")))
        assertNull(mediaLoadFailureReason(IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")))
        assertNull(mediaLoadFailureReason(RuntimeException()))
        assertNull(mediaLoadFailureReason(ApiException("  ")))
    }
}
