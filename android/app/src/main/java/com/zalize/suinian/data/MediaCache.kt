package com.zalize.suinian.data

import java.io.File
import java.security.MessageDigest

/**
 * 附件原件（图片 / 语音）的两级缓存：内存 LRU + 应用私有 cacheDir 落盘。
 * 服务端 /file 是 `Cache-Control: private, no-store`，OkHttp 不会缓存；列表每次滚回来都会重拉整张原图，
 * 这里按 (账号, 笔记, 附件) 键存一份，字节不变（附件只增不改）所以不需要失效，只按容量淘汰。
 * 纯 JVM 实现，方便单测。
 */
class MediaCache(
    private val dir: File,
    private val memoryLimit: Long = DEFAULT_MEMORY_LIMIT,
    private val diskLimit: Long = DEFAULT_DISK_LIMIT,
) {
    class Entry(val bytes: ByteArray, val mime: String)

    private val memory = LinkedHashMap<String, Entry>(16, 0.75f, true)
    private var memoryBytes = 0L

    @Synchronized
    fun get(key: String): Entry? {
        memory[key]?.let { return it }
        val bin = binFile(key)
        val mimeFile = mimeFile(key)
        if (!bin.isFile || !mimeFile.isFile) return null
        val entry = try {
            Entry(bin.readBytes(), mimeFile.readText())
        } catch (_: Exception) {
            return null
        }
        val now = System.currentTimeMillis()
        bin.setLastModified(now)
        mimeFile.setLastModified(now)
        putMemory(key, entry)
        return entry
    }

    /**
     * 落盘文件（语音直接喂 MediaPlayer，不经内存）：磁盘有就返回并刷新时间戳；只在内存里则补写一份；都没有返回 null。
     * 返回的文件随容量淘汰 / clear 可能随时消失，调用方用前需再确认 isFile。
     */
    @Synchronized
    fun file(key: String): File? {
        val bin = binFile(key)
        if (bin.isFile && mimeFile(key).isFile) {
            val now = System.currentTimeMillis()
            bin.setLastModified(now)
            mimeFile(key).setLastModified(now)
            return bin
        }
        val mem = memory[key] ?: return null
        writeDisk(key, mem.bytes, mem.mime)
        return bin.takeIf { it.isFile }
    }

    /** keepInMemory=false：只落盘不占内存 LRU（几 MB 的语音会把整个图片内存缓存挤掉，而语音播放只需要文件） */
    @Synchronized
    fun put(key: String, bytes: ByteArray, mime: String, keepInMemory: Boolean = true) {
        if (keepInMemory) putMemory(key, Entry(bytes, mime)) else memory.remove(key)?.let { memoryBytes -= it.bytes.size }
        writeDisk(key, bytes, mime)
    }

    private fun writeDisk(key: String, bytes: ByteArray, mime: String) {
        if (bytes.size > diskLimit) return
        try {
            dir.mkdirs()
            val tmp = File(dir, "$key.tmp")
            tmp.writeBytes(bytes)
            mimeFile(key).writeText(mime)
            if (!tmp.renameTo(binFile(key))) {
                tmp.delete()
                mimeFile(key).delete()
                return
            }
            trimDisk()
        } catch (_: Exception) {
            // 落盘失败只影响下次冷启动，内存里已经有了
        }
    }

    /** 退出登录 / 注销时清空：私有原件不留在设备上 */
    @Synchronized
    fun clear() {
        memory.clear()
        memoryBytes = 0
        dir.listFiles()?.forEach { it.delete() }
    }

    private fun putMemory(key: String, entry: Entry) {
        memory.remove(key)?.let { memoryBytes -= it.bytes.size }
        if (entry.bytes.size > memoryLimit) return
        memory[key] = entry
        memoryBytes += entry.bytes.size
        val it = memory.entries.iterator()
        while (memoryBytes > memoryLimit && it.hasNext()) {
            val e = it.next()
            it.remove()
            memoryBytes -= e.value.bytes.size
        }
    }

    private fun trimDisk() {
        val files = dir.listFiles { f -> f.name.endsWith(".bin") } ?: return
        var total = files.sumOf { it.length() }
        if (total <= diskLimit) return
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= diskLimit) break
            total -= f.length()
            f.delete()
            File(dir, f.name.removeSuffix(".bin") + ".mime").delete()
        }
    }

    private fun binFile(key: String) = File(dir, "$key.bin")
    private fun mimeFile(key: String) = File(dir, "$key.mime")

    companion object {
        const val DEFAULT_MEMORY_LIMIT = 12L * 1024 * 1024
        const val DEFAULT_DISK_LIMIT = 64L * 1024 * 1024

        /**
         * 缓存键：账号 token 的 sha256 前 16 位（同一设备换号互不可见、盘上不落 token 原文）+ 笔记 id + 附件 id，
         * 三段都只留 [A-Za-z0-9._-]，作为单段文件名安全
         */
        fun key(token: String, noteId: String, attachmentId: String): String {
            val owner = sha256Hex(token).take(16)
            return "${owner}_${safe(noteId)}_${safe(attachmentId)}"
        }

        private fun safe(s: String): String = buildString(s.length) {
            for (c in s) append(if (c.isLetterOrDigit() && c.code < 128 || c == '.' || c == '_' || c == '-') c else '_')
        }

        private fun sha256Hex(s: String): String =
            MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
    }
}
