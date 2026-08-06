package com.zalize.suinian.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "settings")

data class AppSettings(
    val baseUrl: String = "https://suinian.zalize.com",
    val token: String = "",
    val mockMode: Boolean = true,
    val notificationShortcut: Boolean = true,
)

class SettingsRepository(private val context: Context) {

    private object Keys {
        val BASE_URL = stringPreferencesKey("base_url")
        val TOKEN = stringPreferencesKey("token")
        val MOCK_MODE = booleanPreferencesKey("mock_mode")
        val NOTIF_SHORTCUT = booleanPreferencesKey("notif_shortcut")
    }

    val settings: Flow<AppSettings> = context.dataStore.data.map { p ->
        AppSettings(
            baseUrl = p[Keys.BASE_URL] ?: AppSettings().baseUrl,
            token = p[Keys.TOKEN] ?: "",
            mockMode = p[Keys.MOCK_MODE] ?: true,
            notificationShortcut = p[Keys.NOTIF_SHORTCUT] ?: true,
        )
    }

    suspend fun setBaseUrl(v: String) = context.dataStore.edit { it[Keys.BASE_URL] = v.trim().trimEnd('/') }
    suspend fun setToken(v: String) = context.dataStore.edit { it[Keys.TOKEN] = v.trim() }
    suspend fun setMockMode(v: Boolean) = context.dataStore.edit { it[Keys.MOCK_MODE] = v }
    suspend fun setNotificationShortcut(v: Boolean) = context.dataStore.edit { it[Keys.NOTIF_SHORTCUT] = v }
}
