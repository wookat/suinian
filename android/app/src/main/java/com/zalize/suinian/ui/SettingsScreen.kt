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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.input.nestedscroll.nestedScroll
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.zalize.suinian.data.PushPreferences
import com.zalize.suinian.notif.QuickNoteNotification
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    vm: NotesViewModel,
    onBack: () -> Unit,
    onLogout: () -> Unit = {},
    onOpenTags: () -> Unit = {},
    onOpenTrash: () -> Unit = {},
) {
    val settings by vm.settings.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var baseUrl by remember { mutableStateOf(settings.baseUrl) }
    var token by remember { mutableStateOf(settings.token) }
    var initialized by remember { mutableStateOf(false) }
    var confirmRotate by remember { mutableStateOf(false) }
    var confirmRegenRecovery by remember { mutableStateOf(false) }
    var regeneratingRecovery by remember { mutableStateOf(false) }
    var newRecoveryCode by remember { mutableStateOf<String?>(null) }
    var recoveryMessage by remember { mutableStateOf<String?>(null) }
    var confirmLogout by remember { mutableStateOf(false) }
    var rotating by remember { mutableStateOf(false) }
    var rotateMessage by remember { mutableStateOf<String?>(null) }
    var confirmDeleteAccount by remember { mutableStateOf(false) }
    var deleteAccountInput by remember { mutableStateOf("") }
    var deletingAccount by remember { mutableStateOf(false) }
    var deleteAccountMessage by remember { mutableStateOf<String?>(null) }
    var backingUp by remember { mutableStateOf(false) }
    var backupIncludeSensitive by remember { mutableStateOf(false) }
    var backupMessage by remember { mutableStateOf<String?>(null) }
    var showBackupPasswordDialog by remember { mutableStateOf(false) }
    var backupPassword by remember { mutableStateOf("") }
    var restoring by remember { mutableStateOf(false) }
    var restoreMessage by remember { mutableStateOf<String?>(null) }
    var pushPrefs by remember { mutableStateOf<PushPreferences?>(null) }
    var pushPrefsMessage by remember { mutableStateOf<String?>(null) }

    // 推送偏好（与 Web Push 共用，存后端）
    LaunchedEffect(settings.mockMode, settings.token) {
        if (!settings.mockMode && settings.token.isNotBlank()) {
            try {
                pushPrefs = vm.getPushPreferences()
            } catch (_: Exception) {
            }
        }
    }

    val restorePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        restoring = true
        restoreMessage = null
        scope.launch {
            try {
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: throw IllegalStateException("无法读取所选文件")
                if (bytes.size > 200 * 1024 * 1024) {
                    restoreMessage = "备份文件过大：最大支持 200MB"
                } else {
                    val stats = vm.restoreFromBackup(bytes, "backup.zip")
                    restoreMessage = "恢复完成：笔记 ${stats.notesImported}/${stats.notesTotal} 条（跳过重复 ${stats.notesSkipped} 条），媒体 ${stats.mediaImported} 个" +
                        (if (stats.mediaFailed > 0) "，失败 ${stats.mediaFailed} 个" else "") +
                        "。AI 分拣/线索/图谱会在后台陆续补全"
                }
            } catch (e: Exception) {
                restoreMessage = e.message ?: "恢复失败，请稍后重试"
            } finally {
                restoring = false
            }
        }
    }

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

    if (confirmRegenRecovery) {
        AlertDialog(
            onDismissRequest = { confirmRegenRecovery = false },
            title = { Text("重新生成恢复码？") },
            text = { Text("旧恢复码立即作废，新码只显示一次，请准备好安全保存") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRegenRecovery = false
                    regeneratingRecovery = true
                    recoveryMessage = null
                    scope.launch {
                        try {
                            newRecoveryCode = vm.regenerateRecoveryCode()
                        } catch (e: Exception) {
                            recoveryMessage = e.message ?: "生成失败，请稍后重试"
                        } finally {
                            regeneratingRecovery = false
                        }
                    }
                }) { Text("生成") }
            },
            dismissButton = { TextButton(onClick = { confirmRegenRecovery = false }) { Text("取消") } },
        )
    }

    newRecoveryCode?.let { code ->
        AlertDialog(
            onDismissRequest = { /* 必须点确认，避免误触丢失唯一一次展示的恢复码 */ },
            title = { Text("请保存新恢复码") },
            text = {
                Column {
                    Text(
                        "忘记密码时，恢复码是找回账号的唯一方式。它只显示这一次，服务端不存明文，丢失后无法找回——请抄下来或存进密码管理器。",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(code, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace)
                }
            },
            confirmButton = {
                TextButton(onClick = { newRecoveryCode = null }) { Text("我已安全保存") }
            },
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

    // pinned scrollBehavior：滚动时顶栏切换到 surfaceContainer 色，与下方内容
    // 形成明确分界，否则分区标题滑到栏下时看起来像被同色背景裁切遮挡
    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior()
    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                scrollBehavior = scrollBehavior,
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

            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { confirmRegenRecovery = true },
                modifier = Modifier.fillMaxWidth(),
                enabled = !regeneratingRecovery && !settings.mockMode && settings.token.isNotBlank(),
            ) { Text(if (regeneratingRecovery) "生成中…" else "重新生成恢复码") }
            Spacer(Modifier.height(4.dp))
            Text(
                "恢复码是忘记密码时找回账号的唯一方式，丢失或泄露时可在此重新生成（旧码同时作废）",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            recoveryMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
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
            Text("提醒", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(8.dp))
            val reminderPermissionLauncher = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission()
            ) { }
            val prefs = pushPrefs
            if (settings.mockMode || settings.token.isBlank()) {
                Text(
                    "提醒需要连接真实后端（关闭 Mock 并配置 Token）",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("待办到点提醒", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "待办到期时发通知（后台每 15 分钟检查一次）",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = prefs?.todoReminderPush ?: true,
                        enabled = prefs != null,
                        onCheckedChange = { v ->
                            scope.launch {
                                try {
                                    pushPrefs = vm.updatePushPreferences(todoReminderPush = v)
                                    if (v && Build.VERSION.SDK_INT >= 33 &&
                                        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                                    ) {
                                        reminderPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                } catch (e: Exception) {
                                    pushPrefsMessage = e.message ?: "保存失败"
                                }
                            }
                        },
                    )
                }
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("每日回顾推送", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "每天推送一条往日碎念回顾",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = prefs?.dailyReviewPush ?: true,
                        enabled = prefs != null,
                        onCheckedChange = { v ->
                            scope.launch {
                                try {
                                    pushPrefs = vm.updatePushPreferences(dailyReviewPush = v)
                                    if (v && Build.VERSION.SDK_INT >= 33 &&
                                        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                                    ) {
                                        reminderPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                } catch (e: Exception) {
                                    pushPrefsMessage = e.message ?: "保存失败"
                                }
                            }
                        },
                    )
                }
                pushPrefsMessage?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(8.dp))
                Text(
                    "提醒靠后台周期任务拉取，部分机型的省电策略会推迟或拦截后台任务。若提醒不及时，建议在系统设置中将碎念设为「不限制电池用量」。两类通知可在系统通知设置中分渠道单独关闭。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = {
                        try {
                            context.startActivity(
                                Intent(
                                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.fromParts("package", context.packageName, null),
                                )
                            )
                        } catch (_: Exception) {
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("去系统设置调整电池/通知") }
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

            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onOpenTrash,
                modifier = Modifier.fillMaxWidth(),
                enabled = !settings.mockMode,
            ) { Text("最近删除") }
            Spacer(Modifier.height(4.dp))
            Text(
                "删除的笔记保留 30 天，期间可恢复或立即彻底删除",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = backupIncludeSensitive,
                    onCheckedChange = { backupIncludeSensitive = it },
                    enabled = !settings.mockMode && !backingUp && !restoring,
                )
                Text("包含敏感内容（默认脱敏：敏感笔记正文以占位符替代、敏感附件原件不导出）", style = MaterialTheme.typography.bodyMedium)
            }
            if (backupIncludeSensitive) {
                Text(
                    "注意：导出的 zip 将包含敏感笔记的明文（如密码），请妥善保管，不要上传到不可信的地方。恢复导入时会重新加密存储",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(4.dp))
            }
            OutlinedButton(
                onClick = {
                    if (backupIncludeSensitive) {
                        // 敏感明文整包导出需密码复核（与后端 X-Suinian-Password 校验配对）
                        backupPassword = ""
                        showBackupPasswordDialog = true
                        return@OutlinedButton
                    }
                    backingUp = true
                    backupMessage = null
                    scope.launch {
                        try {
                            val fileName = vm.downloadBackupToDownloads(backupIncludeSensitive)
                            backupMessage = "已保存到系统下载：$fileName"
                        } catch (e: Exception) {
                            backupMessage = e.message ?: "备份下载失败，请稍后重试"
                        } finally {
                            backingUp = false
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !settings.mockMode && !backingUp && !restoring,
            ) { Text(if (backingUp) "备份打包中，请稍候…" else "下载完整备份（zip 含媒体）") }
            if (showBackupPasswordDialog) {
                AlertDialog(
                    onDismissRequest = { showBackupPasswordDialog = false },
                    title = { Text("验证账号密码") },
                    text = {
                        Column {
                            Text("导出将包含敏感内容明文，请输入账号密码验证：")
                            Spacer(Modifier.height(8.dp))
                            OutlinedTextField(
                                value = backupPassword,
                                onValueChange = { backupPassword = it },
                                singleLine = true,
                                visualTransformation = PasswordVisualTransformation(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            showBackupPasswordDialog = false
                            val pw = backupPassword
                            backupPassword = ""
                            backingUp = true
                            backupMessage = null
                            scope.launch {
                                try {
                                    val fileName = vm.downloadBackupToDownloads(true, pw)
                                    backupMessage = "已保存到系统下载：$fileName"
                                } catch (e: Exception) {
                                    backupMessage = e.message ?: "备份下载失败，请稍后重试"
                                } finally {
                                    backingUp = false
                                }
                            }
                        }) { Text("验证并备份") }
                    },
                    dismissButton = { TextButton(onClick = { showBackupPasswordDialog = false }) { Text("取消") } },
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "完整备份包含全部笔记字段与语音/图片/文件原件，可在下方「从备份恢复」无损搬家到新账号/新实例",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            backupMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }

            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = { restorePicker.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")) },
                modifier = Modifier.fillMaxWidth(),
                enabled = !settings.mockMode && !restoring && !backingUp,
            ) { Text(if (restoring) "恢复中，请勿离开…" else "从备份恢复（选择 zip）") }
            Spacer(Modifier.height(4.dp))
            Text(
                "导入「下载完整备份」导出的 zip：笔记保留原时间/标签/分类，重复导入自动跳过（最大 200MB）",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            restoreMessage?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }

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
