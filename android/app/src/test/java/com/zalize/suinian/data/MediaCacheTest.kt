package com.zalize.suinian.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MediaCacheTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun bytes(n: Int, fill: Int) = ByteArray(n) { fill.toByte() }

    @Test
    fun `put then get returns same bytes and mime, survives a new instance (disk)`() {
        val dir = tmp.newFolder("media")
        val c1 = MediaCache(dir)
        val k = MediaCache.key("tok", "note-1", "att-1")
        c1.put(k, bytes(1000, 7), "image/jpeg")
        val hit = c1.get(k)
        assertNotNull(hit)
        assertArrayEquals(bytes(1000, 7), hit!!.bytes)
        assertEquals("image/jpeg", hit.mime)

        val c2 = MediaCache(dir)
        val disk = c2.get(k)
        assertNotNull(disk)
        assertArrayEquals(bytes(1000, 7), disk!!.bytes)
        assertEquals("image/jpeg", disk.mime)
        assertNull(c2.get(MediaCache.key("tok", "note-1", "att-2")))
    }

    @Test
    fun `memory LRU evicts least recently used but disk still serves it`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir, memoryLimit = 2500, diskLimit = 1L shl 20)
        c.put("a", bytes(1000, 1), "image/png")
        c.put("b", bytes(1000, 2), "image/png")
        c.get("a")
        c.put("c", bytes(1000, 3), "image/png")
        assertTrue(java.io.File(dir, "b.bin").isFile)
        assertNotNull(c.get("a"))
        assertNotNull(c.get("c"))
        assertNotNull(c.get("b"))
    }

    @Test
    fun `disk trims oldest entries beyond limit, oversized entry not written to disk`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir, memoryLimit = 1L shl 20, diskLimit = 2500)
        c.put("old", bytes(1000, 1), "image/png")
        java.io.File(dir, "old.bin").setLastModified(1_000_000L)
        java.io.File(dir, "old.mime").setLastModified(1_000_000L)
        c.put("mid", bytes(1000, 2), "image/png")
        java.io.File(dir, "mid.bin").setLastModified(2_000_000L)
        c.put("new", bytes(1000, 3), "image/png")
        assertFalse(java.io.File(dir, "old.bin").exists())
        assertFalse(java.io.File(dir, "old.mime").exists())
        assertTrue(java.io.File(dir, "mid.bin").isFile)
        assertTrue(java.io.File(dir, "new.bin").isFile)

        c.put("huge", bytes(3000, 4), "image/png")
        assertFalse(java.io.File(dir, "huge.bin").exists())
        assertFalse(java.io.File(dir, "huge.tmp").exists())
        assertNotNull(c.get("huge"))
    }

    @Test
    fun `file returns disk entry and refreshes mtime, null when absent`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir)
        c.put("v", bytes(3000, 9), "audio/amr")
        val bin = java.io.File(dir, "v.bin")
        bin.setLastModified(1_000_000L)
        val f = c.file("v")
        assertNotNull(f)
        assertEquals(bin.absolutePath, f!!.absolutePath)
        assertArrayEquals(bytes(3000, 9), f.readBytes())
        assertTrue("file() 应刷新 mtime 让最近播过的语音最后被淘汰", bin.lastModified() > 1_000_000L)
        assertNull(c.file("missing"))
        assertNull(MediaCache(dir).file("missing"))
    }

    @Test
    fun `file materializes a memory-only entry back to disk`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir)
        c.put("v", bytes(500, 4), "audio/mp4")
        assertTrue(java.io.File(dir, "v.bin").delete())
        assertTrue(java.io.File(dir, "v.mime").delete())
        val f = c.file("v")
        assertNotNull(f)
        assertArrayEquals(bytes(500, 4), f!!.readBytes())
        assertEquals("audio/mp4", java.io.File(dir, "v.mime").readText())
    }

    @Test
    fun `put keepInMemory=false lands on disk only and does not evict images from memory`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir, memoryLimit = 2500, diskLimit = 1L shl 20)
        c.put("img-a", bytes(1000, 1), "image/png")
        c.put("img-b", bytes(1000, 2), "image/png")
        c.put("voice", bytes(2000, 3), "audio/amr", keepInMemory = false)
        assertTrue(java.io.File(dir, "voice.bin").isFile)
        assertNotNull(c.file("voice"))

        // 删掉磁盘副本后还能 get 到 = 在内存里；图片应都在，语音不在
        dir.listFiles()!!.forEach { it.delete() }
        assertNotNull(c.get("img-a"))
        assertNotNull(c.get("img-b"))
        assertNull(c.get("voice"))
        assertNull(c.file("voice"))
    }

    @Test
    fun `put keepInMemory=false drops a previous in-memory copy of the same key`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir, memoryLimit = 2500, diskLimit = 1L shl 20)
        c.put("v", bytes(2000, 1), "audio/amr")
        c.put("v", bytes(2000, 1), "audio/amr", keepInMemory = false)
        assertTrue(java.io.File(dir, "v.bin").delete())
        assertNull("之前的内存副本应被释放", c.get("v"))
        c.put("img-a", bytes(1200, 2), "image/png")
        c.put("img-b", bytes(1200, 3), "image/png")
        dir.listFiles()!!.forEach { it.delete() }
        assertNotNull(c.get("img-a"))
        assertNotNull(c.get("img-b"))
    }

    @Test
    fun `clear removes memory and disk`() {
        val dir = tmp.newFolder("media")
        val c = MediaCache(dir)
        c.put("a", bytes(10, 1), "audio/ogg")
        c.clear()
        assertNull(c.get("a"))
        assertEquals(0, dir.listFiles()!!.size)
        assertNull(MediaCache(dir).get("a"))
    }

    @Test
    fun `key isolates accounts, hides token, and is a safe single path segment`() {
        val k1 = MediaCache.key("token-A", "n", "a")
        val k2 = MediaCache.key("token-B", "n", "a")
        assertNotEquals(k1, k2)
        assertFalse(k1.contains("token-A"))
        assertEquals(k1, MediaCache.key("token-A", "n", "a"))

        val weird = MediaCache.key("t", "../../n:1", "a/b 漢")
        assertTrue(weird.matches(Regex("[A-Za-z0-9._-]+")))
        assertFalse(weird.contains("/"))
    }
}
