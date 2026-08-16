package com.zalize.suinian.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zalize.suinian.data.SettingsRepository
import com.zalize.suinian.data.api.ApiClient
import com.zalize.suinian.data.api.ApiException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val DEFAULT_BASE_URL = "https://suinian-api.zalize.com"

private enum class OnboardingMode { Register, Login, Token, Recover }

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
    var recoveryInput by rememberSaveable { mutableStateOf("") }
    var busy by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    // 注册/恢复成功后一次性展示的恢复码（确认保存后才进入主界面）
    var pendingCode by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingToken by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingName by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingTour by rememberSaveable { mutableStateOf(false) }
    // 注册/找回成功但服务端恢复码生成失败（降级返回 null）：需明确告知去设置页补生成
    var pendingCodeMissing by rememberSaveable { mutableStateOf(false) }

    fun finish(savedToken: String, savedName: String?, showTour: Boolean = false) {
        scope.launch {
            // 落库写入不可取消：避免引导页退出组合时 UI 作用域被取消、token 未持久化
            withContext(NonCancellable) {
                settingsRepo.completeOnboarding(baseUrl, savedToken, savedName, showTour)
            }
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
                busy = true
                scope.launch {
                    try {
                        // 先验证 token 可用再落库，避免带着无效 token 进入主界面
                        ApiClient(baseUrl.trim().trimEnd('/'), token.trim()).getPreferences()
                        finish(token.trim(), null)
                    } catch (e: ApiException) {
                        error = e.message
                        busy = false
                    } catch (e: Exception) {
                        error = "无法连接服务器，请检查 API 地址和网络"
                        busy = false
                    }
                }
            }
            OnboardingMode.Register, OnboardingMode.Login, OnboardingMode.Recover -> {
                if (name.isBlank() || password.isBlank()) {
                    error = if (mode == OnboardingMode.Recover) "请填写用户名和新密码" else "请填写用户名和密码"
                    return
                }
                if (mode == OnboardingMode.Recover && recoveryInput.isBlank()) {
                    error = "请填写恢复码"
                    return
                }
                busy = true
                scope.launch {
                    try {
                        val res = when (mode) {
                            OnboardingMode.Register -> ApiClient.register(baseUrl.trim(), name.trim(), password)
                            OnboardingMode.Recover -> ApiClient.recover(baseUrl.trim(), name.trim(), recoveryInput.trim(), password)
                            else -> ApiClient.login(baseUrl.trim(), name.trim(), password)
                        }
                        val code = res.recoveryCode
                        if (code != null) {
                            // 恢复码只下发这一次：先让用户确认保存再进入主界面
                            pendingCode = code
                            pendingToken = res.apiToken
                            pendingName = res.user.name
                            pendingTour = mode == OnboardingMode.Register
                        } else if (mode != OnboardingMode.Login) {
                            // 恢复码生成失败：先明确告知再进主界面，否则用户直到
                            // 忘密码那天才发现自己没有任何找回途径
                            pendingCodeMissing = true
                            pendingToken = res.apiToken
                            pendingName = res.user.name
                            pendingTour = mode == OnboardingMode.Register
                        } else {
                            finish(res.apiToken, res.user.name, showTour = mode == OnboardingMode.Register)
                        }
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
                OnboardingMode.Register to "注册",
                OnboardingMode.Login to "登录",
                OnboardingMode.Token to "Token",
                OnboardingMode.Recover to "找回",
            ).forEachIndexed { i, (m, label) ->
                SegmentedButton(
                    selected = mode == m,
                    onClick = { mode = m; error = null },
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = 4),
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
                if (mode == OnboardingMode.Recover) {
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = recoveryInput,
                        onValueChange = { recoveryInput = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("恢复码（注册时保存的 XXXX-XXXX-XXXX-XXXX）") },
                        singleLine = true,
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = {
                        Text(
                            when (mode) {
                                OnboardingMode.Register -> "密码（至少 8 位）"
                                OnboardingMode.Recover -> "新密码（至少 8 位）"
                                else -> "密码"
                            }
                        )
                    },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                if (mode == OnboardingMode.Recover) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "用注册时保存的恢复码重置密码。成功后旧恢复码作废，会下发一个新恢复码，请重新保存。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
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
                    mode == OnboardingMode.Recover -> "重置密码并登录"
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

    if (pendingCodeMissing) {
        AlertDialog(
            onDismissRequest = { /* 必须点确认，确保用户看到恢复码缺失提示 */ },
            title = { Text("恢复码未能生成") },
            text = {
                Text(
                    "操作已成功，但服务端未能生成恢复码。恢复码是忘记密码时找回账号的唯一方式，" +
                        "请进入应用后尽快在设置页点「重新生成恢复码」并安全保存。",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val t = pendingToken
                    val n = pendingName
                    pendingCodeMissing = false
                    if (t != null) finish(t, n, showTour = pendingTour)
                }) { Text("我知道了，进入应用后去生成") }
            },
        )
    }

    val code = pendingCode
    if (code != null) {
        AlertDialog(
            onDismissRequest = { /* 必须点确认，避免误触丢失唯一一次展示的恢复码 */ },
            title = { Text("请保存你的恢复码") },
            text = {
                Column {
                    Text(
                        "忘记密码时，这个恢复码是找回账号的唯一方式（产品不收集邮箱/手机号）。" +
                            "它只显示这一次，服务端不存明文，丢失后无法找回——请抄下来或存进密码管理器。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        code,
                        style = MaterialTheme.typography.titleMedium,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val t = pendingToken
                    val n = pendingName
                    pendingCode = null
                    if (t != null) finish(t, n, showTour = pendingTour)
                }) { Text("我已安全保存，继续") }
            },
        )
    }
}
