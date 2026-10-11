package com.zalize.suinian.ui.components

import com.zalize.suinian.data.Note

/** 敏感 / 受守遮罩卡的状态判定（与 web note-card 同口径）；纯函数便于 JVM 单测 */
enum class MaskKind {
    /** 已标注敏感、正文加密；等 cron 文本复判 */
    REJUDGING,
    /** 图片笔记由视觉模型判敏（粘性位，文本复判不解） */
    VISION,
    /** 未标注敏感、但正文带口令 / 密钥称谓：问答引用卡不回传原文 */
    GUARDED,
    /** 一般敏感（含手动标记） */
    SENSITIVE,
}

fun maskKind(note: Note): MaskKind = when {
    !note.isSensitive -> MaskKind.GUARDED
    note.meta?.needsRetriage == true -> MaskKind.REJUDGING
    note.meta?.visionSensitive == true -> MaskKind.VISION
    else -> MaskKind.SENSITIVE
}

/**
 * 卡片是否要遮罩：已标注敏感的一律遮（点开可看）；未标注但服务端占位（`content_withheld` 且 `guarded`）的
 * 也遮——它的 content 本来就不是原文，直接摊开只会显示占位句。
 */
fun shouldMask(note: Note, revealed: Boolean): Boolean =
    !revealed && (note.isSensitive || (note.contentWithheld == true && note.guarded == true))

fun maskChipText(kind: MaskKind, revealing: Boolean): String = when {
    revealing -> "取回原文中…"
    kind == MaskKind.GUARDED -> "含口令 / 密钥一类内容，点击查看原文"
    kind == MaskKind.VISION -> "图片被判为含密码 / 凭证，点击查看"
    else -> "敏感内容，点击查看"
}

fun maskHintText(kind: MaskKind, revealError: String?): String = when {
    revealError != null -> "取回原文失败：$revealError，点击重试"
    kind == MaskKind.GUARDED ->
        "这条未标注敏感，但正文带口令 / 密钥一类称谓：问答引用卡不回传原文，点开后按登录态取回；取回后可在菜单「标记为敏感」加密保护"
    kind == MaskKind.REJUDGING ->
        "疑似密码/凭据类信息，已先加密保护，AI 复判中；若复判为普通内容会自动恢复明文展示"
    kind == MaskKind.VISION ->
        "图片识别模型判断图中含密码 / 凭证类信息，已加密保护（搜索仍能搜到、问答仍会引用这张卡片，但 AI 只拿到占位符，原图与识别文字只在你点开时显示）。模型只看图片、不会因后续文字复判而改判，对文字密集的资料照片、提到「密码」「凭据」等字样但没有实际取值的普通内容也可能误判——点开核对原图，若不是凭据，请在菜单「取消敏感标记」恢复明文展示"
    else ->
        "已加密保护：搜索仍能搜到、问答仍会引用这张卡片，但 AI 只拿到占位符，原文只在你点开时显示；若属误判，可在菜单「取消敏感标记」恢复明文展示"
}

/** 点开遮罩时是否要先按 id 取回原文：服务端占位卡（搜索命中 / 问答引用）的 content 不是原文 */
fun needsFetchToReveal(note: Note): Boolean = note.contentWithheld == true
