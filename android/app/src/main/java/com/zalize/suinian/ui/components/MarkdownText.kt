package com.zalize.suinian.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** 周报用轻量 Markdown 渲染：#/##/### 标题、- 列表、**加粗**、分隔线、段落 */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier.fillMaxWidth()) {
        markdown.lines().forEach { raw ->
            val line = raw.trimEnd()
            when {
                line.isBlank() -> Spacer(Modifier.height(8.dp))
                line.startsWith("### ") -> Text(
                    inlineMarkdown(line.removePrefix("### ")),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
                line.startsWith("## ") -> Text(
                    inlineMarkdown(line.removePrefix("## ")),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(vertical = 3.dp),
                )
                line.startsWith("# ") -> Text(
                    inlineMarkdown(line.removePrefix("# ")),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
                line == "---" || line == "***" -> HorizontalDivider(Modifier.padding(vertical = 6.dp))
                line.startsWith("- ") || line.startsWith("* ") -> Row {
                    Text("•", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.width(8.dp))
                    Text(inlineMarkdown(line.drop(2)), style = MaterialTheme.typography.bodyMedium)
                }
                Regex("^\\d+\\. ").containsMatchIn(line) -> {
                    val num = line.substringBefore(". ")
                    Row {
                        Text("$num.", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            inlineMarkdown(line.substringAfter(". ")),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
                else -> Text(inlineMarkdown(line), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** 行内 **加粗** 解析 */
private fun inlineMarkdown(text: String): AnnotatedString = buildAnnotatedString {
    var rest = text
    while (true) {
        val start = rest.indexOf("**")
        val end = if (start >= 0) rest.indexOf("**", start + 2) else -1
        if (start < 0 || end < 0) {
            append(rest)
            break
        }
        append(rest.substring(0, start))
        pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
        append(rest.substring(start + 2, end))
        pop()
        rest = rest.substring(end + 2)
    }
}
