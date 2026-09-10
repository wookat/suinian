package com.zalize.suinian.ui

import android.net.Uri

/** 备份下载的全过程状态：挂在 ViewModel 上，离开设置页不中断下载、回来仍能看到进度 / 结果 */
sealed interface BackupDownloadState {
    data object Idle : BackupDownloadState

    /** 接收中；服务端流式打包 zip 没有 Content-Length，total = -1 时只能显示已接收字节 */
    data class Running(val received: Long, val total: Long) : BackupDownloadState

    /**
     * fileName 是实际落盘名（同名时系统改成「name (1).zip」）；shareUri 供「分享」把 zip 发到新设备 / 网盘，
     * inAppDir=true 表示旧系统（< Android 10）存在应用私有目录而非系统「下载」
     */
    data class Done(val fileName: String, val shareUri: Uri?, val inAppDir: Boolean) : BackupDownloadState

    data class Failed(val message: String) : BackupDownloadState
}

const val BACKUP_DOWNLOAD_CANCELLED = "已取消下载，未保存任何文件"

/** 完成后的一行说明：实话说文件在哪——旧系统的应用私有目录在文件管理器里不叫「下载」 */
fun backupDoneLabel(state: BackupDownloadState.Done): String =
    if (state.inAppDir) "已保存到本应用目录 Android/data/com.zalize.suinian/files/Download/${state.fileName}，可点「分享」发到新设备或网盘"
    else "已保存到系统下载：${state.fileName}"

/**
 * 同名文件已存在时按系统 MediaStore 同规则改名：foo.zip → foo (1).zip → foo (2).zip…，绝不覆盖上一份备份。
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

/** 进度条下方的一行说明 */
fun backupDownloadLabel(state: BackupDownloadState.Running): String =
    if (state.total > 0) "下载中 ${formatMb(state.received)} / ${formatMb(state.total)}（${backupDownloadPercent(state)}%）"
    else "服务端打包并传输中，已接收 ${formatMb(state.received)}（备份包越大越久，可离开此页，完成后回来查看结果）"

/** 0–100；服务端未给总长时 null（进度条用不定态） */
fun backupDownloadPercent(state: BackupDownloadState.Running): Int? =
    if (state.total <= 0) null else (state.received * 100 / state.total).toInt().coerceIn(0, 100)

/** 进度按整 MB 变化才值得重组：把 (received, total) 归约成一个可比较的键 */
fun backupDownloadStep(received: Long, total: Long): Long =
    if (total > 0) received * 100 / total else received / (1024 * 1024)

internal fun formatMb(bytes: Long): String = "%.1fMB".format(bytes / 1024.0 / 1024.0)
