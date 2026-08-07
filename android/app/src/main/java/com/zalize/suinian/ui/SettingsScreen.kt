package com.zalize.suinian.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.zalize.suinian.notif.QuickNoteNotification
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    vm: NotesViewModel,
    onBack: () -> Unit,
    onLogout: () -> Unit = {},
    onOpenTags: () -> Unit = {},
) {
    val settings by vm.settings.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var baseUrl by remember { mutableStateOf(settings.baseUrl) }
    var token by remember { mutableStateOf(settings.token) }
    var initialized by remember { mutableStateOf(false) }
    var confirmRotate by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }
    var rotating by remember { mutableStateOf(false) }
    var rotateMessage by remember { mutableStateOf<String?>(null) }
    var confirmDeleteAccount by remember { mutableStateOf(false) }
    var deleteAccountInput by remember { mutableStateOf("") }
    var deletingAccount by remember { mutableStateOf(false) }
    var deleteAccountMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(settings) {
        if (!initialized) {
            baseUrl = settings.baseUrl
            token = settings.token
            initialized = true
        }
    }

    if (confirmRotate) {
        AlertDialog(
            onDismissRequest = { confirmRotate = false },
            title = { Text("轮换 API Token？") },
            text = { Text("旧 token 立即失效，其它设备（微信 bridge / Web）需要换用新 token") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRotate = false
                    rotating = true
                    rotateMessage = null
                    scope.launch {
                        try {
                            val newToken = vm.rotateApiToken()
                            token = newToken
                            rotateMessage = "已轮换，新 token 已保存到本机"
                        } catch (e: Exception) {
                            rotateMessage = e.message ?: "轮换失败，请稍后重试"
                        } finally {
                            rotating = false
                        }
                    }
                }) { Text("轮换") }
            },
            dismissButton = { TextButton(onClick = { confirmRotate = false }) { Text("取消") } },
        )
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出登录？") },
            text = { Text("只清除本机登录状态，云端账号与笔记不受影响，重新登录即可恢复") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    scope.launch {
                        vm.settingsRepo.logout()
                        onLogout()
                    }
                }) { Text("退出登录") }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("取消") } },
        )
    }

    if (confirmDeleteAccount) {
        AlertDialog(
            onDismissRequest = { if (!deletingAccount) confirmDeleteAccount = false },
            title = { Text("永久注销账号？") },
            text = {
                Column {
                    Text("注销将永久删除账号及全部笔记/线索/周报，无法恢复。请输入「注销」两个字确认：")
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = deleteAccountInput,
                        onValueChange = { deleteAccountInput = it },
                        modifier = Modifier.fillMaxWidth(),
                        placeholder = { Text("注销") },
                        singleLine = true,
                        enabled = !deletingAccount,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        deletingAccount = true
                        deleteAccountMessage = null
                        scope.launch {
                            try {
                                vm.deleteAccount()
                                deletingAccount = false
                                confirmDeleteAccount = false
                                onLogout()
                            } catch (e: Exception) {
                                deletingAccount = false
                                deleteAccountMessage = e.message ?: "注销失败，请稍后重试"
                                confirmDeleteAccount = false
                            }
                        }
                    },
                    enabled = !deletingAccount && deleteAccountInput.trim() == "注销",
                ) {
                    Text(
                        if (deletingAccount) "注销中…" else "永久注销",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { confirmDeleteAccount = false },
                    enabled = !deletingAccount,
                ) { Text("取消") }
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text("后端连接", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("API Base URL") },
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("API Token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = {
                    scope.launch {
                        vm.settingsRepo.setBaseUrl(baseUrl)
                        vm.settingsRepo.setToken(token)
                        vm.refresh()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("保存") }

            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { confirmRotate = true },
                modifier = Modifier.fillMaxWidth(),
                enabled = !rotating && !settings.mockMode && settings.token.isNotBlank(),
            ) { Text(if (rotating) "轮换中…" else "轮换 API Token") }
            rotateMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }

            Spacer(Modifier.height(24.dp))
            Text("开关", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Mock 模式", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "后端未就绪时用本地模拟数据（不发真实请求）",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = settings.mockMode,
                    onCheckedChange = { v ->
                        scope.launch {
                            vm.settingsRepo.setMockMode(v)
                            vm.refresh()
                        }
                    },
                )
            }

            Spacer(Modifier.height(16.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("通知栏速记入口", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "通知栏常驻一条快捷速记入口",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                val notifPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted ->
                    if (granted) QuickNoteNotification.show(context)
                }
                Switch(
                    checked = settings.notificationShortcut,
                    onCheckedChange = { v ->
                        scope.launch {
                            vm.settingsRepo.setNotificationShortcut(v)
                            if (v) {
                                val needsPermission = Build.VERSION.SDK_INT >= 33 &&
                                    context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                                if (needsPermission) {
                                    notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                } else {
                                    QuickNoteNotification.show(context)
                                }
                            } else {
                                QuickNoteNotification.hide(context)
                            }
                        }
                    },
                )
            }

            Spacer(Modifier.height(24.dp))
            Text("数据", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = onOpenTags,
                modifier = Modifier.fillMaxWidth(),
                enabled = !settings.mockMode,
            ) { Text("标签管理") }
            Spacer(Modifier.height(4.dp))
            Text(
                "重命名/合并/删除标签，全局生效",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(24.dp))
            Text("账号", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { confirmLogout = true },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("退出登录") }
            Spacer(Modifier.height(4.dp))
            Text(
                "退出登录只清本机登录状态，不删除云端账号与数据",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(24.dp))
            Text("危险操作", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = {
                    deleteAccountInput = ""
                    confirmDeleteAccount = true
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !settings.mockMode && !deletingAccount,
            ) { Text(if (deletingAccount) "注销中…" else "永久注销账号", color = MaterialTheme.colorScheme.error) }
            Spacer(Modifier.height(4.dp))
            Text(
                "注销会永久删除账号及全部笔记/线索/周报，不可恢复；若只想在本机退出，请用上方「退出登录」",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            deleteAccountMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}
