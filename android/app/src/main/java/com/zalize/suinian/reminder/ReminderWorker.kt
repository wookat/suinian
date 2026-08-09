package com.zalize.suinian.reminder

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.ui.components.formatDue
import kotlinx.coroutines.flow.first
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.util.concurrent.TimeUnit

/**
 * 周期拉取后端到期待办与当日回顾，发本地系统通知（不依赖 FCM/Google 服务，
 * 保持开源自部署友好）。尊重后端推送偏好（与 Web Push 共用 /api/preferences），
 * 每条只提醒一次（本地已提醒记录）。
 */
class ReminderWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val app = applicationContext as SuinianApp
        val settings = app.settings.settings.first()
        if (settings.mockMode || settings.token.isBlank()) return Result.success()
        if (!ReminderNotifier.canNotify(applicationContext)) return Result.success()

        val store = ReminderStore(applicationContext)
        store.prune()

        val prefs = try {
            app.repository.getPreferences()
        } catch (_: Exception) {
            return Result.success() // 网络抖动：下个周期再试
        }

        if (prefs.todoReminderPush) {
            try {
                val todos = app.repository.getTodosToday().items
                for (note in dueTodos(todos, Instant.now())) {
                    val key = todoReminderKey(note)
                    if (store.has(key)) continue
                    val title = note.title?.takeIf { it.isNotBlank() } ?: note.content.take(50)
                    ReminderNotifier.notifyTodoDue(
                        applicationContext, key, title,
                        note.todoDue?.let { formatDue(it) },
                    )
                    store.record(key)
                }
            } catch (_: Exception) {
            }
        }

        if (prefs.dailyReviewPush && LocalTime.now().hour >= REVIEW_NOTIFY_HOUR) {
            val date = LocalDate.now().toString()
            val key = reviewReminderKey(date)
            if (!store.has(key)) {
                try {
                    val items = app.repository.getTodayReview().items
                    if (items.isNotEmpty()) {
                        ReminderNotifier.notifyDailyReview(applicationContext, date, items.size)
                        store.record(key)
                    }
                } catch (_: Exception) {
                }
            }
        }
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "suinian-reminders"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ReminderWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
