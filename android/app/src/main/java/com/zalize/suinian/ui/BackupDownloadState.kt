package com.zalize.suinian.ui

import android.net.Uri

/** 备份下载的全过程状态：挂在 ViewModel 上，离开设置页不中断下载、回来仍能看到进度 / 结果 */
sealed interface BackupDownloadState {
    data object Idle : BackupDownloadState

    /**
     * 接收中。total = Content-Length（精确；服务端流式打包 zip 没有，为 -1）；
     * estimate = 服务端预估总长（没有为 -1），只用于「约 n%」，不参与完整性判定；都没有时只显示已接收字节
     */
    data class Running(val received: Long, val total: Long, val estimate: Long = -1) : BackupDownloadState

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
    if (state.inAppDir) "${savedToLabel(state.fileName, inAppDir = true)}，可点「分享」发到新设备或网盘"
    else savedToLabel(state.fileName, inAppDir = false)

/** 进度条下方的一行说明：精确总长按实 / 预估总长带「约」/ 已超出预估只报已接收 / 都没有只报已接收 */
fun backupDownloadLabel(state: BackupDownloadState.Running): String {
    val percent = backupDownloadPercent(state)
    return when {
        state.total > 0 -> "下载中 ${formatMb(state.received)} / ${formatMb(state.total)}（$percent%）"
        percent != null -> "下载中 ${formatMb(state.received)} / 约 ${formatMb(state.estimate)}（约 $percent%）"
        state.estimate > 0 ->
            "服务端打包并传输中，已接收 ${formatMb(state.received)}（预估约 ${formatMb(state.estimate)}，可离开此页，完成后回来查看结果）"
        else -> "服务端打包并传输中，已接收 ${formatMb(state.received)}（备份包越大越久，可离开此页，完成后回来查看结果）"
    }
}

/**
 * 进度条的百分比：精确总长 0–100；预估总长封顶 99（收完才算 100），已接收超出预估后 null（不显示虚假的满条）；
 * 两者都没有时 null（进度条用不定态）
 */
fun backupDownloadPercent(state: BackupDownloadState.Running): Int? = when {
    state.total > 0 -> (state.received * 100 / state.total).toInt().coerceIn(0, 100)
    state.estimate > 0 && state.received <= state.estimate -> (state.received * 100 / state.estimate).toInt().coerceIn(0, 99)
    else -> null
}

/** 进度按百分点 / 整 MB 变化才值得重组：把 (received, total, estimate) 归约成一个可比较的键（超出预估后换区间，跨越时必重组） */
fun backupDownloadStep(received: Long, total: Long, estimate: Long = -1): Long = when {
    total > 0 -> received * 100 / total
    estimate > 0 && received <= estimate -> received * 100 / estimate
    else -> 1_000 + received / (1024 * 1024)
}

internal fun formatMb(bytes: Long): String = "%.1fMB".format(bytes / 1024.0 / 1024.0)
