package com.zalize.suinian.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.SettingsRepository
import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import kotlinx.coroutines.launch

private const val DEFAULT_BASE_URL = "https://suinian-api.zalize.com"

private enum class OnboardingMode { Register, Login, Token }

/** 首次打开引导：注册新账号 / 登录已有账号 / 直接填已有 token */
@Composable
fun OnboardingScreen(
    settingsRepo: SettingsRepository,
    onDone: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf(OnboardingMode.Register) }
    var baseUrl by rememberSaveable { mutableStateOf(DEFAULT_BASE_URL) }
    var name by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    fun finish(savedToken: String, savedName: String?) {
        scope.launch {
            settingsRepo.completeOnboarding(baseUrl, savedToken, savedName)
            onDone()
        }
    }

    fun submit() {
        error = null
        when (mode) {
            OnboardingMode.Token -> {
                if (token.isBlank()) {
                    error = "请填写 API Token"
                    return
                }
                finish(token.trim(), null)
            }
            OnboardingMode.Register, OnboardingMode.Login -> {
                if (name.isBlank() || password.isBlank()) {
                    error = "请填写用户名和密码"
                    return
                }
                busy = true
                scope.launch {
                    try {
                        val res = if (mode == OnboardingMode.Register) {
                            ApiClient.register(baseUrl.trim(), name.trim(), password)
                        } else {
                            ApiClient.login(baseUrl.trim(), name.trim(), password)
                        }
                        finish(res.apiToken, res.user.name)
                    } catch (e: ApiException) {
                        error = e.message
                    } catch (e: Exception) {
                        error = "操作失败，请稍后重试"
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(72.dp))
        Text("碎念", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(8.dp))
        Text(
            "想法、链接、待办，丢进来就好\nAI 帮你分拣归类、串成思考线索",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(32.dp))

        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(
                OnboardingMode.Register to "注册新账号",
                OnboardingMode.Login to "登录",
                OnboardingMode.Token to "已有 Token",
            ).forEachIndexed { i, (m, label) ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { mode = m; error = null },
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = 3),
                ) { Text(label) }
            }
        }
        Spacer(Modifier.height(20.dp))

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("API Base URL") },
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))

        when (mode) {
            OnboardingMode.Token -> {
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("API Token") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
            else -> {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("用户名（2-32 个字符）") },
                    singleLine = true,
                )
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(if (mode == OnboardingMode.Register) "密码（至少 8 位）" else "密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
        }

        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(20.dp))
        Button(
            onClick = { submit() },
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy,
        ) {
            Text(
                when {
                    busy -> "请稍候…"
                    mode == OnboardingMode.Register -> "注册并开始使用"
                    mode == OnboardingMode.Login -> "登录"
                    else -> "开始使用"
                }
            )
        }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = {
            scope.launch {
                settingsRepo.setOnboardingDone(true)
                onDone()
            }
        }, enabled = !busy) {
            Text("先跳过，用 Mock 模式体验")
        }
        Spacer(Modifier.height(32.dp))
    }
}
