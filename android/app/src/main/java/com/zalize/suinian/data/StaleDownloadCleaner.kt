package com.zalize.suinian.data

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * 清掉上一个进程被杀时留下的半个下载文件。
 * Q+：本应用 IS_PENDING=1 的 MediaStore 行——Android 10 直接 insert 的 pending 行没有 date_expires、系统永不清理且占着真实文件名，
 * Android 11+ 要 7 天后才由系统 idle 任务删；旧系统：应用下载目录下的 .part 文件。
 * 每个进程只清一次，并且必须在本进程第一次写下载目录之前调用（此时不可能有本应用正在写的行）
 */
object StaleDownloadCleaner {
    const val PART_SUFFIX = ".part"
    private val lock = Mutex()
    private var cleaned = false

    suspend fun ensureCleaned(context: Context) {
        lock.withLock {
            if (cleaned) return
            withContext(Dispatchers.IO) { runCatching { clean(context) } }
            cleaned = true
        }
    }

    /** 返回清掉的条数；只碰本应用自己的 pending 行 / 自己目录下的 .part */
    fun clean(context: Context): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) cleanPendingRows(context)
        else cleanPartFiles(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS))

    fun cleanPartFiles(dir: File?): Int =
        dir?.listFiles { f -> f.isFile && f.name.endsWith(PART_SUFFIX) }?.count { it.delete() } ?: 0

    private fun cleanPendingRows(context: Context): Int {
        val resolver = context.contentResolver
        val base = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val projection = arrayOf(MediaStore.Downloads._ID)
        val selection = "${MediaStore.Downloads.OWNER_PACKAGE_NAME}=? AND ${MediaStore.Downloads.IS_PENDING}=1"
        val args = arrayOf(context.packageName)
        val cursor = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val queryArgs = Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args)
                putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY)
            }
            resolver.query(base, projection, queryArgs, null)
        } else {
            @Suppress("DEPRECATION")
            resolver.query(MediaStore.setIncludePending(base), projection, selection, args, null)
        } ?: return 0
        val ids = cursor.use { c -> generateSequence { if (c.moveToNext()) c.getLong(0) else null }.toList() }
        return ids.count { id ->
            runCatching { resolver.delete(ContentUris.withAppendedId(base, id), null, null) }.getOrDefault(0) > 0
        }
    }
}
