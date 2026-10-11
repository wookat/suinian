package com.zalize.suinian.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** 备份下载完成态：同名不覆盖（与 MediaStore「name (1).zip」同规则）、完成文案实话说文件位置 */
class BackupDownloadDoneTest {

    @Test
    fun `unique name follows MediaStore convention and never overwrites`() {
        val taken = mutableSetOf("suinian-backup-2026-09-10.zip", "suinian-backup-2026-09-10 (1).zip")
        val exists: (String) -> Boolean = { it in taken }
        assertEquals("suinian-backup-2026-09-11.zip", uniqueDownloadName("suinian-backup-2026-09-11.zip", exists))
        assertEquals("suinian-backup-2026-09-10 (2).zip", uniqueDownloadName("suinian-backup-2026-09-10.zip", exists))
        assertEquals("suinian-backup-2026-09-10-full.zip", uniqueDownloadName("suinian-backup-2026-09-10-full.zip", exists))
        taken += "noext"
        assertEquals("noext (1)", uniqueDownloadName("noext", exists))
        taken += ".hidden"
        assertEquals(".hidden (1)", uniqueDownloadName(".hidden", exists))
    }

    @Test
    fun `second same-day backup lands next to the first on the file system`() {
        val dir = Files.createTempDirectory("suinian-done").toFile()
        val first = File(dir, "suinian-backup-2026-09-10.zip").apply { writeBytes(ByteArray(128)) }
        val exists: (String) -> Boolean = { File(dir, it).exists() }
        val part = File(dir, "suinian-backup-2026-09-10.zip" + com.zalize.suinian.data.StaleDownloadCleaner.PART_SUFFIX)
        part.writeBytes(ByteArray(64))
        val dest = File(dir, uniqueDownloadName("suinian-backup-2026-09-10.zip", exists))
        assertTrue(part.renameTo(dest))
        assertEquals("suinian-backup-2026-09-10 (1).zip", dest.name)
        assertEquals(128, first.length())
        assertEquals(64, dest.length())
    }

    @Test
    fun `done label distinguishes system downloads from the app-private directory`() {
        assertEquals(
            "已保存到系统下载：suinian-backup-2026-09-10 (1).zip",
            backupDoneLabel(BackupDownloadState.Done("suinian-backup-2026-09-10 (1).zip", null, inAppDir = false)),
        )
        val old = backupDoneLabel(BackupDownloadState.Done("suinian-backup-2026-09-10.zip", null, inAppDir = true))
        assertTrue(old, old.contains("Android/data/com.zalize.suinian/files/Download/suinian-backup-2026-09-10.zip"))
        assertTrue(old, old.contains("分享"))
        assertTrue(old, !old.contains("系统下载"))
    }
}
