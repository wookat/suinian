package com.zalize.suinian.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import com.zalize.suinian.SuinianApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.TimeZone

/**
 * 进程存活期间系统时区变化（出差换区、手动改时区）立即把新时区同步到服务端偏好，
 * 不必等下次冷启动 / 重登。ACTION_TIMEZONE_CHANGED 是受保护的系统广播，只有系统能发；
 * Repository 内按 token+时区去重、失败静默，重复触发无副作用。
 */
class TimezoneChangeReceiver(private val scope: CoroutineScope) : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_TIMEZONE_CHANGED) return
        val zoneId = zoneIdFromTimezoneChange(intent.getStringExtra(EXTRA_TIMEZONE), TimeZone.getDefault().id)
        val app = context.applicationContext as? SuinianApp ?: return
        scope.launch { app.repository.syncTimezone(zoneId) }
    }

    companion object {
        /** Intent.EXTRA_TIMEZONE 的字面值（常量 API 30 才公开，广播自 API 1 起就带这个 extra） */
        const val EXTRA_TIMEZONE = "time-zone"

        fun register(context: Context, scope: CoroutineScope) {
            ContextCompat.registerReceiver(
                context,
                TimezoneChangeReceiver(scope),
                IntentFilter(Intent.ACTION_TIMEZONE_CHANGED),
                ContextCompat.RECEIVER_EXPORTED,
            )
        }
    }
}

/**
 * 取广播里的新时区；extra 缺失 / 空白 / 不是已知 IANA id 时回落到进程当前默认时区
 * （框架在派发该广播前已把 TimeZone.getDefault() 更新为新值）。
 */
fun zoneIdFromTimezoneChange(extra: String?, fallback: String): String {
    val id = extra?.trim().orEmpty()
    if (id.isEmpty()) return fallback
    return if (TimeZone.getAvailableIDs().contains(id)) id else fallback
}
