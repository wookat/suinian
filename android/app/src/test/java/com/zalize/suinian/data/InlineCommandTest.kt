package com.zalize.suinian.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InlineCommandTest {

    @Test
    fun `question mark routes to ask`() {
        assertEquals(InlineCommand.Ask("我最近在想什么"), parseInlineCommand("?我最近在想什么"))
        assertEquals(InlineCommand.Ask("我最近在想什么"), parseInlineCommand("？我最近在想什么"))
    }

    @Test
    fun `empty question still parses as ask with blank body`() {
        assertEquals(InlineCommand.Ask(""), parseInlineCommand("?"))
        assertEquals(InlineCommand.Ask(""), parseInlineCommand("？  "))
    }

    @Test
    fun `bang saves raw`() {
        assertEquals(InlineCommand.Raw("买菜 西红柿"), parseInlineCommand("!买菜 西红柿"))
        assertEquals(InlineCommand.Raw("买菜 西红柿"), parseInlineCommand("！买菜 西红柿"))
    }

    @Test
    fun `hash tags with content`() {
        assertEquals(
            InlineCommand.Tags(listOf("工作", "灵感"), "碎念的分享面板再打磨一下"),
            parseInlineCommand("#工作 #灵感 碎念的分享面板再打磨一下"),
        )
    }

    @Test
    fun `single tag`() {
        assertEquals(InlineCommand.Tags(listOf("读书"), "今天读完了一本书"), parseInlineCommand("#读书 今天读完了一本书"))
    }

    @Test
    fun `tags capped at six`() {
        val cmd = parseInlineCommand("#a #b #c #d #e #f #g 内容") as InlineCommand.Tags
        assertEquals(listOf("a", "b", "c", "d", "e", "f"), cmd.tags)
    }

    @Test
    fun `tag without content keeps blank content`() {
        assertEquals(InlineCommand.Tags(listOf("读书"), ""), parseInlineCommand("#读书"))
    }

    @Test
    fun `plain text is not a command`() {
        assertNull(parseInlineCommand("现在的想法是"))
        assertNull(parseInlineCommand("https://example.com"))
    }

    @Test
    fun `leading whitespace is ignored`() {
        assertEquals(InlineCommand.Ask("问题"), parseInlineCommand("  ?问题"))
    }
}
