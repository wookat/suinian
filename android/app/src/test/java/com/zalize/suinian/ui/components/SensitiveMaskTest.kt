package com.zalize.suinian.ui.components

import com.zalize.suinian.data.Note
import com.zalize.suinian.data.NoteMeta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveMaskTest {

    private fun note(
        sensitive: Boolean = true,
        withheld: Boolean? = null,
        guarded: Boolean? = null,
        meta: NoteMeta? = null,
    ) = Note(id = "n", content = "x", isSensitive = sensitive, contentWithheld = withheld, guarded = guarded, meta = meta)

    @Test
    fun mask_kind_precedence_matches_web() {
        assertEquals(MaskKind.SENSITIVE, maskKind(note()))
        assertEquals(MaskKind.REJUDGING, maskKind(note(meta = NoteMeta(needsRetriage = true))))
        // 复判中优先于视觉位：等文本复判的卡仍显示「复判中」
        assertEquals(MaskKind.REJUDGING, maskKind(note(meta = NoteMeta(needsRetriage = true, visionSensitive = true))))
        assertEquals(MaskKind.VISION, maskKind(note(meta = NoteMeta(visionSensitive = true))))
        assertEquals(MaskKind.GUARDED, maskKind(note(sensitive = false, withheld = true, guarded = true)))
    }

    @Test
    fun guarded_placeholder_card_is_masked_even_though_not_sensitive() {
        assertTrue(shouldMask(note(sensitive = false, withheld = true, guarded = true), revealed = false))
        assertFalse(shouldMask(note(sensitive = false, withheld = true, guarded = true), revealed = true))
        // 普通明文卡不遮
        assertFalse(shouldMask(note(sensitive = false), revealed = false))
        // 敏感卡不论有没有占位位都遮
        assertTrue(shouldMask(note(sensitive = true, withheld = true), revealed = false))
        assertTrue(shouldMask(note(sensitive = true), revealed = false))
    }

    @Test
    fun placeholder_cards_need_fetch_but_list_cards_do_not() {
        assertTrue(needsFetchToReveal(note(withheld = true)))
        assertTrue(needsFetchToReveal(note(sensitive = false, withheld = true, guarded = true)))
        // 时间流 GET /api/notes 的敏感卡服务端已解密回传：点开直接显示，不发请求
        assertFalse(needsFetchToReveal(note()))
        assertFalse(needsFetchToReveal(note(withheld = false)))
    }

    @Test
    fun chip_and_hint_copy_by_state() {
        assertEquals("取回原文中…", maskChipText(MaskKind.SENSITIVE, revealing = true))
        assertEquals("敏感内容，点击查看", maskChipText(MaskKind.SENSITIVE, revealing = false))
        assertEquals("敏感内容，点击查看", maskChipText(MaskKind.REJUDGING, revealing = false))
        assertEquals("图片被判为含密码 / 凭证，点击查看", maskChipText(MaskKind.VISION, revealing = false))
        assertEquals("含口令 / 密钥一类内容，点击查看原文", maskChipText(MaskKind.GUARDED, revealing = false))

        assertEquals("取回原文失败：网络连接失败，请检查网络后重试，点击重试", maskHintText(MaskKind.SENSITIVE, "网络连接失败，请检查网络后重试"))
        assertTrue(maskHintText(MaskKind.REJUDGING, null).contains("AI 复判中"))
        assertTrue(maskHintText(MaskKind.VISION, null).contains("模型只看图片"))
        assertTrue(maskHintText(MaskKind.VISION, null).contains("取消敏感标记"))
        assertTrue(maskHintText(MaskKind.GUARDED, null).contains("标记为敏感"))
        assertTrue(maskHintText(MaskKind.SENSITIVE, null).contains("取消敏感标记"))
        assertFalse(maskHintText(MaskKind.SENSITIVE, null).contains("复判"))
    }
}
