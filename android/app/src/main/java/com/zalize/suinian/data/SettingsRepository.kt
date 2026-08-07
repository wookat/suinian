package com.zalize.suinian.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "settings")

/** 老版本误把 Web 域名当默认 API 地址存了下来，读取时纠正 */
private const val LEGACY_WEB_URL = "https://suinian.zalize.com"

data class AppSettings(
    val baseUrl: String = "https://suinian-api.zalize.com",
    val token: String = "",
    val mockMode: Boolean = true,
    val notificationShortcut: Boolean = false,
    val onboardingDone: Boolean = false,
    val userName: String = "",
)

class SettingsRepository(private val context: Context) {

    private object Keys {
        val BASE_URL = stringPreferencesKey("base_url")
        val TOKEN = stringPreferencesKey("token")
        val MOCK_MODE = booleanPreferencesKey("mock_mode")
        val NOTIF_SHORTCUT = booleanPreferencesKey("notif_shortcut")
        val ONBOARDING_DONE = booleanPreferencesKey("onboarding_done")
        val USER_NAME = stringPreferencesKey("user_name")
        val ASK_CHAT = stringPreferencesKey("ask_chat_v1")
    }

    val settings: Flow<AppSettings> = context.dataStore.data.map { p ->
        AppSettings(
            baseUrl = (p[Keys.BASE_URL] ?: AppSettings().baseUrl)
                .let { if (it == LEGACY_WEB_URL) AppSettings().baseUrl else it },
            token = p[Keys.TOKEN] ?: "",
            mockMode = p[Keys.MOCK_MODE] ?: true,
            notificationShortcut = p[Keys.NOTIF_SHORTCUT] ?: false,
            // 已配好 token 的老用户无需再走首启引导
            onboardingDone = p[Keys.ONBOARDING_DONE] ?: !(p[Keys.TOKEN].isNullOrBlank()),
            userName = p[Keys.USER_NAME] ?: "",
        )
    }

    /** 问答会话本地保存（JSON 字符串） */
    val askChatJson: Flow<String> = context.dataStore.data.map { it[Keys.ASK_CHAT] ?: "" }

    suspend fun setBaseUrl(v: String) = context.dataStore.edit { it[Keys.BASE_URL] = v.trim().trimEnd('/') }
    suspend fun setToken(v: String) = context.dataStore.edit { it[Keys.TOKEN] = v.trim() }
    suspend fun setMockMode(v: Boolean) = context.dataStore.edit { it[Keys.MOCK_MODE] = v }
    suspend fun setNotificationShortcut(v: Boolean) = context.dataStore.edit { it[Keys.NOTIF_SHORTCUT] = v }
    suspend fun setOnboardingDone(v: Boolean) = context.dataStore.edit { it[Keys.ONBOARDING_DONE] = v }
    suspend fun setUserName(v: String) = context.dataStore.edit { it[Keys.USER_NAME] = v.trim() }
    suspend fun setAskChatJson(v: String) = context.dataStore.edit { it[Keys.ASK_CHAT] = v }

    /** 首启引导完成：单事务写入，避免分步写时 token 先落库触发重组、后续写入被取消 */
    suspend fun completeOnboarding(baseUrl: String, token: String, userName: String?) =
        context.dataStore.edit {
            it[Keys.BASE_URL] = baseUrl.trim().trimEnd('/')
            it[Keys.TOKEN] = token.trim()
            if (userName != null) it[Keys.USER_NAME] = userName.trim()
            it[Keys.MOCK_MODE] = false
            it[Keys.ONBOARDING_DONE] = true
        }
}
