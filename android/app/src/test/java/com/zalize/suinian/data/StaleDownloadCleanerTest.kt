package com.zalize.suinian.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 旧系统（<Q）路径：上一进程留下的 .part 半文件在下次写下载目录前被清掉，完整备份与无关文件不动 */
class StaleDownloadCleanerTest {

    private fun tmpDir(): File = Files.createTempDirectory("suinian-dl").toFile()

    @Test
    fun `deletes only part files and keeps completed downloads`() {
        val dir = tmpDir()
        val stale = File(dir, "suinian-backup-2026-09-10.zip" + StaleDownloadCleaner.PART_SUFFIX).apply { writeBytes(ByteArray(64)) }
        val stale2 = File(dir, "receipt.pdf" + StaleDownloadCleaner.PART_SUFFIX).apply { writeBytes(ByteArray(8)) }
        val done = File(dir, "suinian-backup-2026-09-09.zip").apply { writeBytes(ByteArray(128)) }
        val other = File(dir, "notes.txt").apply { writeText("keep") }
        val subdir = File(dir, "sub" + StaleDownloadCleaner.PART_SUFFIX).apply { mkdirs() }

        assertEquals(2, StaleDownloadCleaner.cleanPartFiles(dir))

        assertFalse(stale.exists())
        assertFalse(stale2.exists())
        assertTrue(done.exists())
        assertTrue(other.exists())
        assertTrue(subdir.exists())
        assertEquals(0, StaleDownloadCleaner.cleanPartFiles(dir))
    }

    @Test
    fun `missing directory is a no-op`() {
        assertEquals(0, StaleDownloadCleaner.cleanPartFiles(null))
        assertEquals(0, StaleDownloadCleaner.cleanPartFiles(File(tmpDir(), "does-not-exist")))
    }

    @Test
    fun `part suffix is what openDownload appends before the final rename`() {
        val dir = tmpDir()
        val final = File(dir, "suinian-backup-2026-09-10.zip")
        val part = File(dir, final.name + StaleDownloadCleaner.PART_SUFFIX)
        part.writeBytes(ByteArray(32))
        assertTrue(part.renameTo(final))
        assertFalse(part.exists())
        assertEquals(32, final.length())
        assertEquals(0, StaleDownloadCleaner.cleanPartFiles(dir))
    }
}
