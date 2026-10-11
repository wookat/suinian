package com.zalize.suinian.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZoomMathTest {
    private fun assertPair(ex: Float, ey: Float, actual: Pair<Float, Float>) {
        assertEquals(ex, actual.first, 0.001f)
        assertEquals(ey, actual.second, 0.001f)
    }

    @Test
    fun `fit keeps aspect ratio and touches the limiting edge`() {
        assertPair(1080f, 810f, fitContentSize(1080f, 2000f, 4000, 3000))
        assertPair(1080f, 1440f, fitContentSize(1080f, 2000f, 3000, 4000))
        assertPair(1080f, 1800f, fitContentSize(1080f, 2000f, 3000, 5000))
        assertPair(0f, 0f, fitContentSize(1080f, 2000f, 0, 0))
    }

    @Test
    fun `pan is locked at 1x and clamped to image edges when zoomed`() {
        assertPair(0f, 0f, clampPan(300f, -200f, 1f, 1080f, 810f, 1080f, 2000f))
        // 2x：宽 2160 比容器 1080 长 ⇒ 横向可拖 ±540；高 1620 比 2000 短 ⇒ 纵向不动
        assertPair(540f, 0f, clampPan(900f, -50f, 2f, 1080f, 810f, 1080f, 2000f))
        assertPair(-540f, 0f, clampPan(-900f, 30f, 2f, 1080f, 810f, 1080f, 2000f))
        // 3x：高 2430 > 2000 ⇒ 纵向 ±215
        assertPair(-100f, 215f, clampPan(-100f, 999f, 3f, 1080f, 810f, 1080f, 2000f))
    }

    @Test
    fun `zooming about a focus point keeps that point fixed`() {
        // 手指在中心右 200px；1x→2x 时该点下的内容不动 ⇒ 平移 -200
        assertPair(-200f, 0f, zoomAboutFocus(0f, 0f, 1f, 2f, 200f, 0f))
        // 中心缩放不产生平移
        assertPair(0f, 0f, zoomAboutFocus(0f, 0f, 1f, 3f, 0f, 0f))
        // 已有平移时按比例
        assertPair(-500f, 100f, zoomAboutFocus(-100f, 100f, 2f, 4f, 300f, 100f))
    }

    @Test
    fun `double tap toggles between 1x and 2_5x`() {
        assertEquals(2.5f, nextDoubleTapScale(1f), 0f)
        assertEquals(1f, nextDoubleTapScale(2.5f), 0f)
        assertEquals(1f, nextDoubleTapScale(4f), 0f)
    }

    @Test
    fun `fullscreen decode limit is twice the screen within 2048 to 4096`() {
        assertEquals(4096, fullscreenDecodeMaxDim(1080, 2400))
        assertEquals(3840, fullscreenDecodeMaxDim(1080, 1920))
        assertEquals(2048, fullscreenDecodeMaxDim(480, 800))
    }

    @Test
    fun `redecode only when the card bitmap was downsampled and fullscreen can do better`() {
        // 12MP：卡片 sample 2、全屏 4096 sample 1 ⇒ 值得
        assertTrue(fullscreenNeedsRedecode(4000, 3000, 2048, 4096))
        // 1080p 截图：卡片就没采样 ⇒ 不重解
        assertFalse(fullscreenNeedsRedecode(1080, 1920, 2048, 4096))
        // 48MP：卡片 sample 4、全屏 sample 2 ⇒ 值得
        assertTrue(fullscreenNeedsRedecode(8000, 6000, 2048, 4096))
        // 小屏（全屏上限 = 卡片上限）⇒ 同一档不重解
        assertFalse(fullscreenNeedsRedecode(4000, 3000, 2048, 2048))
        assertFalse(fullscreenNeedsRedecode(0, 0, 2048, 4096))
    }
}
