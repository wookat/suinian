package com.zalize.suinian.ui

import com.zalize.suinian.data.RestoreStats

/** 备份恢复的全过程状态：挂在 ViewModel 上，离开设置页再回来仍能看到进度 / 结果 */
sealed interface RestoreState {
    data object Idle : RestoreState

    /** 正在读取所选文件 */
    data object Reading : RestoreState

    /** 上传中（sent < total）或上传完等服务端导入（sent >= total） */
    data class Running(val sent: Long, val total: Long) : RestoreState {
        val uploaded: Boolean get() = total > 0 && sent >= total
    }

    data class Done(val stats: RestoreStats) : RestoreState

    data class Failed(val message: String) : RestoreState
}

const val RESTORE_CANCELLED_DURING_UPLOAD = "已取消：备份包未上传完，服务端不会导入"
const val RESTORE_CANCELLED_AFTER_UPLOAD =
    "已停止等待：备份包已上传完，服务端可能仍在导入，请稍后刷新列表确认；重新上传同一备份会自动跳过已导入的笔记"

/** 取消时给用户的文案：上传是否已完成决定服务端会不会导入 */
fun restoreCancelledMessage(state: RestoreState): String =
    if (state is RestoreState.Running && state.uploaded) RESTORE_CANCELLED_AFTER_UPLOAD else RESTORE_CANCELLED_DURING_UPLOAD

/** 进度条下方的一行说明 */
fun restoreProgressLabel(state: RestoreState.Running): String =
    if (state.uploaded) "上传完成，服务端导入中…（备份包越大越久，可离开此页，完成后回来查看结果）"
    else "上传中 ${formatMb(state.sent)} / ${formatMb(state.total)}（${restorePercent(state)}%）"

/** 0–100；total 未知时 0 */
fun restorePercent(state: RestoreState.Running): Int =
    if (state.total <= 0) 0 else (state.sent * 100 / state.total).toInt().coerceIn(0, 100)
