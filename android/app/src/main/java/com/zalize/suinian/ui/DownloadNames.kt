package com.zalize.suinian.ui

/** 落盘后的位置说明：Q+ 在系统「下载」，旧系统在应用私有目录（文件管理器的「下载」里没有） */
fun savedToLabel(fileName: String, inAppDir: Boolean): String =
    if (inAppDir) "已保存到本应用目录 Android/data/com.zalize.suinian/files/Download/$fileName"
    else "已保存到系统下载：$fileName"

private const val MAX_NAME_BYTES = 255

/**
 * 把服务端给的文件名（来自用户上传 / 微信转发的原名，不保证合法）变成能安全落盘的单段文件名，
 * 与 MediaStore 对 DISPLAY_NAME 的 sanitize 同规则：控制字符与 " * / : < > ? \\ | 换成 _，
 * 空 / . / .. 用 fallback，UTF-8 最长 255 字节（按字符截，不会截断半个汉字）
 */
fun safeDownloadName(name: String?, fallback: String = "suinian-file"): String {
    val trimmed = name?.trim().orEmpty()
    if (trimmed.isEmpty() || trimmed == "." || trimmed == "..") return fallback
    val sb = StringBuilder(trimmed.length)
    for (c in trimmed) sb.append(if (isValidNameChar(c)) c else '_')
    var res = sb.toString()
    while (res.toByteArray(Charsets.UTF_8).size > MAX_NAME_BYTES) res = res.dropLast(1)
    return res
}

private fun isValidNameChar(c: Char): Boolean = when {
    c.code <= 0x1f || c.code == 0x7f -> false
    c == '"' || c == '*' || c == '/' || c == ':' || c == '<' || c == '>' || c == '?' || c == '\\' || c == '|' -> false
    else -> true
}

/**
 * 同名文件已存在时按系统 MediaStore 同规则改名：foo.zip → foo (1).zip → foo (2).zip…，绝不覆盖上一份。
 * exists 由调用方给（文件系统 / 测试桩）
 */
fun uniqueDownloadName(name: String, exists: (String) -> Boolean): String {
    if (!exists(name)) return name
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var i = 1
    while (true) {
        val candidate = "$base ($i)$ext"
        if (!exists(candidate)) return candidate
        i++
    }
}
