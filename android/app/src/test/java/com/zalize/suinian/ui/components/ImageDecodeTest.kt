package com.zalize.suinian.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class ImageDecodeTest {
    @Test
    fun `no downsampling when longest side is within limit`() {
        assertEquals(1, sampleSizeFor(1024, 768, 2048))
        assertEquals(1, sampleSizeFor(2048, 1536, 2048))
        assertEquals(1, sampleSizeFor(100, 2048, 2048))
    }

    @Test
    fun `12MP camera photo decodes at quarter area, 48MP at sixteenth`() {
        assertEquals(2, sampleSizeFor(4000, 3000, 2048))
        assertEquals(2, sampleSizeFor(3000, 4000, 2048))
        assertEquals(4, sampleSizeFor(8000, 6000, 2048))
        assertEquals(4, sampleSizeFor(8192, 6144, 2048))
        assertEquals(2, sampleSizeFor(4096, 3072, 2048))
        assertEquals(2, sampleSizeFor(2049, 100, 2048))
    }

    @Test
    fun `unknown bounds fall back to full decode`() {
        assertEquals(1, sampleSizeFor(0, 0, 2048))
        assertEquals(1, sampleSizeFor(-1, 500, 2048))
        assertEquals(1, sampleSizeFor(4000, 3000, 0))
    }
}
