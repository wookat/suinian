package com.zalize.suinian.ui.components

import com.zalize.suinian.data.api.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
    fun raw_system_exceptions_are_not_shown() {
        assertNull(mediaLoadFailureReason(IOException("ENOSPC (No space left on device)")))
        assertNull(mediaLoadFailureReason(IllegalStateException("Mock 模式下不可用，请在设置中关闭 Mock")))
        assertNull(mediaLoadFailureReason(RuntimeException()))
        assertNull(mediaLoadFailureReason(ApiException("  ")))
    }
}
