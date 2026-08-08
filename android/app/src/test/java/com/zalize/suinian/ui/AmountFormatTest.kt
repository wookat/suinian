package com.zalize.suinian.ui

import com.zalize.suinian.ui.components.formatAmount
import org.junit.Assert.assertEquals
import org.junit.Test

class AmountFormatTest {

    @Test
    fun `known currencies use symbol`() {
        assertEquals("¥35", formatAmount(35.0, "CNY"))
        assertEquals("$9.99", formatAmount(9.99, "USD"))
        assertEquals("€100", formatAmount(100.0, "EUR"))
        assertEquals("£12.50", formatAmount(12.5, "GBP"))
        assertEquals("JP¥800", formatAmount(800.0, "JPY"))
        assertEquals("HK$65", formatAmount(65.0, "HKD"))
    }

    @Test
    fun `unknown currency falls back to code suffix`() {
        assertEquals("42 KRW", formatAmount(42.0, "KRW"))
    }

    @Test
    fun `integer amounts drop decimals, others keep two`() {
        assertEquals("¥1200", formatAmount(1200.0, "CNY"))
        assertEquals("¥3.50", formatAmount(3.5, "CNY"))
    }
}
