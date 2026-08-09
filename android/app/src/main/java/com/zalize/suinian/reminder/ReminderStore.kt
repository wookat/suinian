package com.zalize.suinian.reminder

import android.content.Context

/** 本地已提醒记录：key → 提醒时间戳，保证每条只提醒一次；过期条目定期清理 */
class ReminderStore(context: Context) {

    private val prefs = context.getSharedPreferences("suinian-reminders", Context.MODE_PRIVATE)

    fun has(key: String): Boolean = prefs.contains(key)

    fun record(key: String, now: Long = System.currentTimeMillis()) {
        prefs.edit().putLong(key, now).apply()
    }

    /** 清理超过保留期的记录（服务端待办清单只含当天/过期项，14 天足够覆盖去重窗口） */
    fun prune(maxAgeMillis: Long = 14L * 24 * 60 * 60 * 1000, now: Long = System.currentTimeMillis()) {
        val editor = prefs.edit()
        var changed = false
        for ((key, value) in prefs.all) {
            if (value is Long && now - value > maxAgeMillis) {
                editor.remove(key)
                changed = true
            }
        }
        if (changed) editor.apply()
    }
}
