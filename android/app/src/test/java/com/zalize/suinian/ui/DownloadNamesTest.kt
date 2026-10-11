package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 文件笔记原件落盘名：服务端原名不保证合法，与 MediaStore sanitize 同规则；同名不覆盖；文案实话说位置 */
class DownloadNamesTest {

    @Test
    fun `safe name keeps ordinary names including chinese and spaces`() {
        assertEquals("简历 2026.pdf", safeDownloadName("简历 2026.pdf"))
        assertEquals("report (1).docx", safeDownloadName(" report (1).docx "))
        assertEquals("a.b.c.tar.gz", safeDownloadName("a.b.c.tar.gz"))
    }

    @Test
    fun `safe name neutralises path separators and reserved chars like MediaStore`() {
        assertEquals("_.._x.pdf", safeDownloadName("/../x.pdf"))
        assertEquals("a_b_c.txt", safeDownloadName("a/b\\c.txt"))
        assertEquals("__________.bin", safeDownloadName("\"*/:<>?\\|\u0007.bin"))
        assertEquals("suinian-file", safeDownloadName(".."))
        assertEquals("suinian-file", safeDownloadName("."))
        assertEquals("suinian-file", safeDownloadName(""))
        assertEquals("suinian-file", safeDownloadName(null))
        assertEquals("x", safeDownloadName(null, fallback = "x"))
    }

    @Test
    fun `safe name trims to 255 utf8 bytes without splitting a character`() {
        val long = "汉".repeat(200) + ".pdf"
        val res = safeDownloadName(long)
        val bytes = res.toByteArray(Charsets.UTF_8).size
        assertTrue("bytes=$bytes", bytes <= 255)
        assertTrue(res.all { it == '汉' })
        assertEquals(85, res.length)
    }

    @Test
    fun `sanitised name never escapes the download directory`() {
        val dir = Files.createTempDirectory("suinian-names").toFile()
        val f = File(dir, safeDownloadName("../../escape.txt"))
        assertEquals(dir.canonicalPath, f.canonicalFile.parentFile.canonicalPath)
        assertEquals(".._.._escape.txt", f.name)
    }

    @Test
    fun `two file notes with the same original name both survive`() {
        val dir = Files.createTempDirectory("suinian-names").toFile()
        val exists: (String) -> Boolean = { File(dir, it).exists() }
        File(dir, "合同.pdf").writeBytes(ByteArray(3))
        val second = File(dir, uniqueDownloadName("合同.pdf", exists))
        second.writeBytes(ByteArray(5))
        val third = File(dir, uniqueDownloadName("合同.pdf", exists))
        assertEquals("合同 (1).pdf", second.name)
        assertEquals("合同 (2).pdf", third.name)
        assertEquals(3, File(dir, "合同.pdf").length())
    }

    @Test
    fun `saved label tells the truth about the location`() {
        assertEquals("已保存到系统下载：合同 (1).pdf", savedToLabel("合同 (1).pdf", inAppDir = false))
        assertEquals(
            "已保存到本应用目录 Android/data/com.zalize.suinian/files/Download/合同.pdf",
            savedToLabel("合同.pdf", inAppDir = true),
        )
    }
}
