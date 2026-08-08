package com.zalize.suinian.data

/** 速记框内联指令（与 Web/微信指令对齐）：?问题 提问；!内容 原样保存；#标签 内容 手动打标 */
sealed class InlineCommand {
    data class Ask(val question: String) : InlineCommand()
    data class Raw(val content: String) : InlineCommand()
    data class Tags(val tags: List<String>, val content: String) : InlineCommand()
}

private val TAGS_HEAD_REGEX = Regex("^((?:#[^\\s#＃]+[ \\t]*)+)([\\s\\S]*)$")
private val TAG_REGEX = Regex("#[^\\s#＃]+")
private const val MAX_TAGS = 6

fun parseInlineCommand(value: String): InlineCommand? {
    val v = value.trimStart()
    if (v.startsWith("?") || v.startsWith("？")) return InlineCommand.Ask(v.drop(1).trim())
    if (v.startsWith("!") || v.startsWith("！")) return InlineCommand.Raw(v.drop(1).trim())
    if (v.startsWith("#")) {
        val m = TAGS_HEAD_REGEX.matchEntire(v) ?: return null
        val tags = TAG_REGEX.findAll(m.groupValues[1]).map { it.value.drop(1) }.take(MAX_TAGS).toList()
        if (tags.isEmpty()) return null
        return InlineCommand.Tags(tags, m.groupValues[2].trim())
    }
    return null
}
