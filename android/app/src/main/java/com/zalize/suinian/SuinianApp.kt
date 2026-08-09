package com.zalize.suinian

import android.app.Application
import com.zalize.suinian.data.NotesRepository
import com.zalize.suinian.data.SettingsRepository
import com.zalize.suinian.data.local.AppDatabase
import com.zalize.suinian.notif.QuickNoteNotification
import com.zalize.suinian.reminder.ReminderNotifier
import com.zalize.suinian.reminder.ReminderWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class SuinianApp : Application() {

    lateinit var settings: SettingsRepository
        private set
    lateinit var repository: NotesRepository
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        settings = SettingsRepository(this)
        repository = NotesRepository(this, settings, AppDatabase.get(this).pendingNoteDao())
        QuickNoteNotification.createChannel(this)
        ReminderNotifier.createChannels(this)
        ReminderWorker.schedule(this)
        appScope.launch {
            if (settings.settings.first().notificationShortcut) {
                QuickNoteNotification.show(this@SuinianApp)
            }
        }
    }

    companion object {
        fun from(app: Application): SuinianApp = app as SuinianApp
    }
}
