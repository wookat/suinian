package com.zalize.suinian.ui.components

import com.zalize.suinian.data.api.ApiException

/**
 * 附件原件加载失败给用户看的原因：只认网络 / 服务端 / 缓存层已写成可读文案的 ApiException，
 * 其余异常（解码失败、Mock 模式等）不把系统原文带给用户，返回 null 由卡片只显示「加载失败」。
 */
fun mediaLoadFailureReason(e: Throwable): String? =
    (e as? ApiException)?.message?.takeIf { it.isNotBlank() }

/**
 * 列表刷新 / 网络恢复时值得自动重拉的失败：只有连接级失败与服务端 5xx。
 * 404 / 401 / 缓存写失败 / 解码失败重拉也不会变，留给用户点击重试（与 web mediaLoadFailureAutoRetries 同口径）。
 */
fun mediaLoadFailureAutoRetries(e: Throwable): Boolean {
    val api = e as? ApiException ?: return false
    return api.network || (api.status ?: 0) >= 500
}
