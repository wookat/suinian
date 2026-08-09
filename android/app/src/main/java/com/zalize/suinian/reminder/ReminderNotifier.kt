package com.zalize.suinian.reminder

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import com.zalize.suinian.R
import com.zalize.suinian.ui.MainActivity

/** 待办到点 / 每日回顾本地通知（渠道分开，可在系统设置分别关闭） */
object ReminderNotifier {

    const val CHANNEL_TODO = "todo_reminder"
    const val CHANNEL_REVIEW = "daily_review"

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_TODO,
                context.getString(R.string.notif_channel_todo),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.notif_channel_todo_desc) }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_REVIEW,
                context.getString(R.string.notif_channel_review),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.notif_channel_review_desc) }
        )
    }

    fun canNotify(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun contentIntent(context: Context, route: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_NAVIGATE_ROUTE, route)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** 待办到点：一条待办一条通知，点开跳「待办」页 */
    fun notifyTodoDue(context: Context, key: String, title: String, dueText: String?) {
        if (!canNotify(context)) return
        val id = key.hashCode()
        val notification = NotificationCompat.Builder(context, CHANNEL_TODO)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(context.getString(R.string.notif_todo_title))
            .setContentText(if (dueText != null) "$title（$dueText）" else title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(if (dueText != null) "$title（$dueText）" else title))
            .setAutoCancel(true)
            .setContentIntent(contentIntent(context, "todos", id))
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, notification)
    }

    /** 每日回顾：一天一条汇总通知，点开跳首页（回顾卡在首页顶部） */
    fun notifyDailyReview(context: Context, date: String, count: Int) {
        if (!canNotify(context)) return
        val id = reviewReminderKey(date).hashCode()
        val notification = NotificationCompat.Builder(context, CHANNEL_REVIEW)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(context.getString(R.string.notif_review_title))
            .setContentText(context.getString(R.string.notif_review_text, count))
            .setAutoCancel(true)
            .setContentIntent(contentIntent(context, "home", id))
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, notification)
    }
}
