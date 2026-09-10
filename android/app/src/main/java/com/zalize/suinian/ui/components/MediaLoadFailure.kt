package com.zalize.suinian.ui.components

import com.zalize.suinian.data.api.ApiException

/**
 * 附件原件加载失败给用户看的原因：只认网络 / 服务端 / 缓存层已写成可读文案的 ApiException，
 * 其余异常（解码失败、Mock 模式等）不把系统原文带给用户，返回 null 由卡片只显示「加载失败」。
 */
fun mediaLoadFailureReason(e: Throwable): String? =
    (e as? ApiException)?.message?.takeIf { it.isNotBlank() }
