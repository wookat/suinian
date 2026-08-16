package com.zalize.suinian.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.zalize.suinian.data.InlineCommand
import com.zalize.suinian.data.NotesViewLimits
import com.zalize.suinian.data.parseInlineCommand
import com.zalize.suinian.ui.components.MAX_RECORD_SECONDS
import com.zalize.suinian.ui.components.VoiceRecorderController
import kotlinx.coroutines.delay
import java.io.File
import androidx.compose.foundation.border
import com.zalize.suinian.ui.components.DailyReviewCard
import com.zalize.suinian.ui.components.FirstRunTour
import com.zalize.suinian.ui.components.NoteCard
import com.zalize.suinian.ui.components.NoteEditSheet
import kotlinx.coroutines.launch

/** 时间流加载骨架屏：首登/切账号时代替菜单圈，不闪任何旧数据 */
@Composable
private fun TimelineSkeleton(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.75f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 700),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "skeletonAlpha",
    )
    val barColor = MaterialTheme.colorScheme.surfaceVariant
    Column(modifier = modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(5) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        Modifier
                            .width(88.dp)
                            .height(12.dp)
                            .alpha(alpha)
                            .background(barColor, RoundedCornerShape(6.dp))
                    )
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(14.dp)
                            .alpha(alpha)
                            .background(barColor, RoundedCornerShape(6.dp))
                    )
                    Box(
                        Modifier
                            .fillMaxWidth(0.62f)
                            .height(14.dp)
                            .alpha(alpha)
                            .background(barColor, RoundedCornerShape(6.dp))
                    )
                }
            }
        }
    }
}

private val categories = listOf(
    null to "全部",
    "idea" to "想法",
    "todo" to "待办",
    "collect" to "收藏",
    "data" to "资料",
    "expense" to "支出",
    "income" to "收入",
    "transfer" to "资金往来",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    vm: NotesViewModel,
    modifier: Modifier = Modifier,
    focusQuickNoteSignal: Int = 0,
    onAsk: ((String) -> Unit)? = null,
) {
    val ui by vm.ui.collectAsState()
    val pending by vm.pendingCount.collectAsState()
    val settings by vm.settings.collectAsState()
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable { mutableStateOf("") }
    var confirmBatchDelete by rememberSaveable { mutableStateOf(false) }
    var batchTagDialog by rememberSaveable { mutableStateOf(false) }
    var batchTagInput by rememberSaveable { mutableStateOf("") }
    var batchCategoryDialog by rememberSaveable { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val context = LocalContext.current

    // 文件选择器：PDF/txt/md/docx → 上传入库
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val resolver = context.contentResolver
            val bytes = try {
                resolver.openInputStream(uri)?.use { it.readBytes() }
            } catch (_: Exception) {
                null
            }
            if (bytes == null || bytes.isEmpty()) return@rememberLauncherForActivityResult
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            val name = try {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }
            } catch (_: Exception) {
                null
            } ?: uri.lastPathSegment ?: "file"
            vm.uploadFile(bytes, mime, name)
        }
    }

    // 图片直接入口：相册选图 / 拍照 → 既有图片管线（type=image，AI 视觉识别）
    fun uploadImageUri(uri: Uri) {
        val resolver = context.contentResolver
        val bytes = try {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
        if (bytes == null || bytes.isEmpty()) {
            vm.showToast("读取图片失败，请重试")
            return
        }
        val mime = resolver.getType(uri) ?: "image/jpeg"
        val name = uri.lastPathSegment?.substringAfterLast('/') ?: "image.jpg"
        vm.uploadImage(bytes, mime, name)
    }

    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) uploadImageUri(uri)
    }

    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri
        if (ok && uri != null) uploadImageUri(uri)
        cameraUri = null
    }
    fun launchCamera() {
        try {
            val file = File.createTempFile("camera-", ".jpg", context.cacheDir)
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            cameraUri = uri
            takePicture.launch(uri)
        } catch (e: Exception) {
            vm.showToast(e.message ?: "无法打开相机")
        }
    }

    // 语音录音入口：对齐 Web 麦克风按钮 → 既有转写管线（type=audio，Whisper）
    val voiceRecorder = remember { VoiceRecorderController(context) }
    var recording by remember { mutableStateOf(false) }
    var recordSeconds by remember { mutableStateOf(0) }
    fun startRecording() {
        try {
            voiceRecorder.start()
            recordSeconds = 0
            recording = true
        } catch (e: Exception) {
            vm.showToast(e.message ?: "无法开始录音")
        }
    }
    fun stopRecordingAndSend() {
        recording = false
        val result = voiceRecorder.stop()
        if (result == null) {
            vm.showToast("录音太短，请重试")
            return
        }
        vm.uploadAudio(result.first, "audio/mp4", result.second)
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else vm.showToast("需要麦克风权限才能录音，请在系统设置中开启")
    }
    LaunchedEffect(recording) {
        while (recording) {
            delay(1000)
            recordSeconds++
            if (recordSeconds >= MAX_RECORD_SECONDS) {
                stopRecordingAndSend()
            }
        }
    }

    // 新注册用户首次进入：一次性 4 步功能引导，可跳过不再显示
    if (!settings.tourSeen && !settings.mockMode && settings.token.isNotBlank()) {
        FirstRunTour(onDone = { scope.launch { vm.settingsRepo.setTourSeen(true) } })
    }

    LaunchedEffect(focusQuickNoteSignal) {
        if (focusQuickNoteSignal > 0) {
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }

    // 编辑底部弹层
    ui.editingNote?.let { editing ->
        NoteEditSheet(
            note = editing,
            saving = ui.savingEdit,
            conflict = ui.editConflict,
            onDismissConflict = { vm.dismissEditConflict() },
            onDismiss = { vm.closeEditor() },
            onSave = { content, title, category, tags, todoDue ->
                vm.saveEdit(editing, content, title, category, tags, todoDue)
            },
        )
    }

    if (confirmBatchDelete) {
        AlertDialog(
            onDismissRequest = { confirmBatchDelete = false },
            title = { Text(if (ui.allMatching) "删除当前筛选下的全部匹配笔记？" else "删除选中的 ${ui.selectedIds.size} 条笔记？") },
            text = { Text(if (ui.allMatching) "将删除全部匹配结果（不限已加载项），删除后可在提示条内撤销" else "删除后可在提示条内撤销") },
            confirmButton = {
                TextButton(onClick = {
                    confirmBatchDelete = false
                    vm.batchDelete()
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmBatchDelete = false }) { Text("取消") } },
        )
    }

    if (batchTagDialog) {
        AlertDialog(
            onDismissRequest = { batchTagDialog = false },
            title = { Text(if (ui.allMatching) "给全部匹配笔记加标签" else "给 ${ui.selectedIds.size} 条笔记加标签") },
            text = {
                OutlinedTextField(
                    value = batchTagInput,
                    onValueChange = { batchTagInput = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("标签名") },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        batchTagDialog = false
                        vm.batchAddTag(batchTagInput)
                        batchTagInput = ""
                    },
                    enabled = batchTagInput.trim().removePrefix("#").isNotEmpty(),
                ) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { batchTagDialog = false }) { Text("取消") } },
        )
    }

    if (batchCategoryDialog) {
        AlertDialog(
            onDismissRequest = { batchCategoryDialog = false },
            title = { Text(if (ui.allMatching) "把全部匹配笔记改分类为" else "把 ${ui.selectedIds.size} 条笔记改分类为") },
            text = {
                Column {
                    categories.filter { it.first != null }.forEach { (value, label) ->
                        TextButton(
                            onClick = {
                                batchCategoryDialog = false
                                vm.batchSetCategory(value!!)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(label) }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { batchCategoryDialog = false }) { Text("取消") } },
        )
    }

    Column(modifier = modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        // 多选模式：顶部操作栏替代速记/搜索
        if (ui.selectionMode) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                IconButton(onClick = { vm.exitSelection() }) {
                    Icon(Icons.Outlined.Close, contentDescription = "退出多选")
                }
                Text(
                    if (ui.allMatching) "已选全部匹配结果" else "已选 ${ui.selectedIds.size} 条",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { vm.toggleSelectAllLoaded() }) {
                    Text(if (ui.allMatching || (ui.notes.isNotEmpty() && ui.selectedIds.size == ui.notes.size)) "清空" else "全选")
                }
            }
            if (!ui.allMatching && ui.notes.isNotEmpty() && ui.selectedIds.size == ui.notes.size) {
                TextButton(onClick = { vm.selectAllMatching() }) {
                    Text("选中全部匹配结果", color = MaterialTheme.colorScheme.primary)
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                val hasSelection = (ui.selectedIds.isNotEmpty() || ui.allMatching) && !ui.batchBusy
                AssistChip(
                    onClick = { batchTagDialog = true },
                    label = { Text("加标签") },
                    enabled = hasSelection,
                )
                AssistChip(
                    onClick = { batchCategoryDialog = true },
                    label = { Text("改分类") },
                    enabled = hasSelection,
                )
                AssistChip(
                    onClick = { confirmBatchDelete = true },
                    label = {
                        val progress = ui.batchProgress
                        Text(
                            when {
                                progress != null -> "删除中 ${progress.first}/${progress.second}…"
                                ui.batchBusy -> "处理中…"
                                else -> "删除"
                            },
                            color = MaterialTheme.colorScheme.error,
                        )
                    },
                    enabled = hasSelection,
                )
            }
            Spacer(Modifier.height(8.dp))
        }

        if (!ui.selectionMode) {
        // 速记框（内联指令：?提问 !原样存 #打标）
        val overLimit = draft.length > NotesViewLimits.MAX_CONTENT_CHARS
        val command = remember(draft) { parseInlineCommand(draft) }
        val commandHint = when (command) {
            is InlineCommand.Ask -> "问答模式：发送后直接向你的笔记提问，不会存为笔记"
            is InlineCommand.Raw -> "原样保存：不经 AI 分拣，存为「想法」"
            is InlineCommand.Tags -> "手动打标：" + command.tags.joinToString(" ") { "#$it" }
            null -> null
        }
        // 以问号结尾的疑问句（R159 D-3）：?前缀指令很难被发现，直接发送会存成
        // 笔记（往往分拣成 todo）。给可点的内联提示，不改变发送行为
        val questionLike = command == null && draft.trim().length > 1 &&
            (draft.trimEnd().endsWith("？") || draft.trimEnd().endsWith("?"))
        if (recording) {
            // 录音中：替换速记框，显示计时 + 取消/停止（对齐 Web 录音条）
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Icon(Icons.Outlined.Mic, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "录音中 %d:%02d".format(recordSeconds / 60, recordSeconds % 60),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = {
                        recording = false
                        voiceRecorder.cancel()
                    }) { Text("取消") }
                    Button(onClick = { stopRecordingAndSend() }) {
                        Icon(Icons.Outlined.Stop, contentDescription = null)
                        Spacer(Modifier.width(4.dp))
                        Text("停止并转写")
                    }
                }
            }
        } else {
        // 窄屏/大显示尺寸（系统显示大小最大档）下，四个尾部图标 + 麦克风会吃掉
        // 几乎全部宽度；折叠相册/拍照/文件到一个「+」菜单，保证输入区可用
        val compactCapture = LocalConfiguration.current.screenWidthDp < 400
        var attachMenuOpen by remember { mutableStateOf(false) }
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focusRequester),
            // 占位文案必须限行：窄屏/大显示尺寸（系统显示大小最大档）下不限行会
            // 逐字竖排撞爆输入框，把笔记列表挤出屏幕
            placeholder = { Text("现在的想法是…… 支持 ?提问 !原样存 #打标", maxLines = 2, overflow = TextOverflow.Ellipsis) },
            shape = RoundedCornerShape(16.dp),
            maxLines = 4,
            isError = overLimit,
            supportingText = when {
                overLimit -> {
                    { Text("内容过长：最多 ${NotesViewLimits.MAX_CONTENT_CHARS} 字符，当前 ${draft.length} 字符") }
                }
                commandHint != null -> {
                    { Text(commandHint, color = MaterialTheme.colorScheme.primary) }
                }
                questionLike -> {
                    {
                        Text(
                            "像是在提问？点此改为向笔记提问（直接发送仍会存为笔记）",
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable { draft = "?" + draft.trimStart() },
                        )
                    }
                }
                else -> null
            },
            leadingIcon = {
                // 语音录音入口（对齐 Web 麦克风按钮）
                IconButton(
                    onClick = {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            startRecording()
                        } else {
                            micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    },
                    enabled = !ui.sending,
                ) {
                    Icon(Icons.Outlined.Mic, contentDescription = "语音速记")
                }
            },
            trailingIcon = {
                val launchFilePicker = {
                    filePicker.launch(
                        arrayOf(
                            "application/pdf",
                            "text/plain",
                            "text/markdown",
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        )
                    )
                }
                Row {
                    if (compactCapture) {
                        IconButton(onClick = { attachMenuOpen = true }, enabled = !ui.sending) {
                            Icon(Icons.Outlined.AddCircleOutline, contentDescription = "更多入库方式")
                        }
                        DropdownMenu(expanded = attachMenuOpen, onDismissRequest = { attachMenuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("相册选图入库") },
                                leadingIcon = { Icon(Icons.Outlined.Image, contentDescription = null) },
                                onClick = {
                                    attachMenuOpen = false
                                    imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("拍照入库") },
                                leadingIcon = { Icon(Icons.Outlined.PhotoCamera, contentDescription = null) },
                                onClick = {
                                    attachMenuOpen = false
                                    launchCamera()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("选择文件入库") },
                                leadingIcon = { Icon(Icons.Outlined.AttachFile, contentDescription = null) },
                                onClick = {
                                    attachMenuOpen = false
                                    launchFilePicker()
                                },
                            )
                        }
                    } else {
                    IconButton(
                        onClick = { imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                        enabled = !ui.sending,
                    ) {
                        Icon(Icons.Outlined.Image, contentDescription = "相册选图入库")
                    }
                    IconButton(
                        onClick = { launchCamera() },
                        enabled = !ui.sending,
                    ) {
                        Icon(Icons.Outlined.PhotoCamera, contentDescription = "拍照入库")
                    }
                    IconButton(
                        onClick = { launchFilePicker() },
                        enabled = !ui.sending,
                    ) {
                        Icon(Icons.Outlined.AttachFile, contentDescription = "选择文件入库")
                    }
                    }
                    val commandEmpty = when (command) {
                        is InlineCommand.Ask -> command.question.isBlank()
                        is InlineCommand.Raw -> command.content.isBlank()
                        is InlineCommand.Tags -> command.content.isBlank()
                        null -> false
                    }
                    IconButton(
                        onClick = {
                            vm.quickSend(draft, onAsk)
                            draft = ""
                        },
                        enabled = draft.isNotBlank() && !overLimit && !ui.sending && !commandEmpty,
                    ) {
                        Icon(
                            if (command is InlineCommand.Ask) Icons.Outlined.AutoAwesome
                            else Icons.AutoMirrored.Outlined.Send,
                            contentDescription = if (command is InlineCommand.Ask) "提问" else "记下",
                        )
                    }
                }
            },
        )
        }

        Spacer(Modifier.height(8.dp))

        // 搜索框（问答已移到底部「问答」Tab，多轮对话）
        OutlinedTextField(
            value = ui.query,
            onValueChange = { vm.setQuery(it) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("搜索碎念…", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            shape = RoundedCornerShape(16.dp),
            singleLine = true,
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                IconButton(onClick = { vm.search() }) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "搜索")
                }
            },
        )

        Spacer(Modifier.height(8.dp))
        }

        // 分类筛选 + 组合筛选入口（标签/时间/来源，与关键词搜索叠加）
        val activeFilterCount = listOfNotNull(ui.filterTag, ui.filterSource, ui.filterTime).size
        var filtersExpanded by rememberSaveable { mutableStateOf(false) }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = filtersExpanded || activeFilterCount > 0,
                onClick = { filtersExpanded = !filtersExpanded },
                label = { Text(if (activeFilterCount > 0) "筛选 $activeFilterCount" else "筛选") },
                leadingIcon = { Icon(Icons.Outlined.Tune, contentDescription = "组合筛选") },
            )
            categories.forEach { (value, label) ->
                FilterChip(
                    selected = ui.category == value,
                    onClick = { vm.setCategory(value) },
                    label = { Text(label) },
                )
            }
        }

        if (filtersExpanded) {
            Spacer(Modifier.height(4.dp))
            // 时间范围
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("时间", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TimeRange.entries.forEach { range ->
                    FilterChip(
                        selected = ui.filterTime == range,
                        onClick = { vm.setFilterTime(if (ui.filterTime == range) null else range) },
                        label = { Text(range.label) },
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            // 来源
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("来源", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SOURCE_OPTIONS.forEach { (value, label) ->
                    FilterChip(
                        selected = ui.filterSource == value,
                        onClick = { vm.setFilterSource(if (ui.filterSource == value) null else value) },
                        label = { Text(label) },
                    )
                }
            }
            if (ui.availableTags.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("标签", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    ui.availableTags.forEach { tag ->
                        FilterChip(
                            selected = ui.filterTag == tag,
                            onClick = { vm.setFilterTag(if (ui.filterTag == tag) null else tag) },
                            label = { Text("#$tag") },
                        )
                    }
                }
            }
            if (activeFilterCount > 0) {
                TextButton(onClick = { vm.clearFilters() }) { Text("清除筛选") }
            }
        }

        if (pending > 0) {
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Outlined.CloudOff,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "$pending 条待重试",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.secondary,
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        when {
            ui.loading && ui.notes.isEmpty() -> {
                TimelineSkeleton()
            }
            ui.error != null -> {
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        ui.error ?: "加载失败",
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    AssistChip(onClick = { vm.refresh() }, label = { Text("重试") })
                }
            }
            ui.notes.isEmpty() && (ui.query.isNotBlank() || ui.category != null || activeFilterCount > 0) -> {
                // 搜索/筛选无结果与“账号里还没有碎念”是两回事，文案必须区分（与 Web 同口径）
                Column(
                    Modifier.fillMaxSize().padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("没有找到匹配的笔记", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "换个关键词、标签或分类试试，或清除筛选条件查看全部碎念。" +
                            if (ui.query.isNotBlank()) "敏感笔记正文已加密存储、不参与搜索。" else "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = {
                        vm.setQuery("")
                        vm.setCategory(null)
                        vm.clearFilters()
                    }) { Text("清除筛选") }
                }
            }
            ui.notes.isEmpty() -> {
                Column(
                    Modifier.fillMaxSize().padding(horizontal = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text("还没有碎念", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "想法、待办、链接、资料，想到什么就丢进来，AI 会帮你自动分拣整理。",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            focusRequester.requestFocus()
                            keyboard?.show()
                        }) { Text("记下第一条") }
                        OutlinedButton(
                            onClick = { vm.seedSamples() },
                            enabled = !ui.seedingSamples && !settings.mockMode,
                        ) { Text(if (ui.seedingSamples) "示例创建中…" else "先丢入 ${SAMPLE_NOTES.size} 条示例看看") }
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "示例会打上 #$SAMPLE_TAG 标签，可随时一键清除",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            else -> {
                val listState = rememberLazyListState()
                LaunchedEffect(ui.notes.firstOrNull()?.id) {
                    listState.scrollToItem(0)
                }
                // 接近列表尾部时自动加载下一页
                val shouldLoadMore by remember {
                    derivedStateOf {
                        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
                        lastVisible >= listState.layoutInfo.totalItemsCount - 3
                    }
                }
                LaunchedEffect(listState) {
                    snapshotFlow { shouldLoadMore }.collect { if (it) vm.loadMore() }
                }
                PullToRefreshBox(
                    isRefreshing = ui.loading,
                    onRefresh = { vm.refresh() },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (!ui.selectionMode && ui.reviewItems.isNotEmpty()) {
                            item(key = "daily-review") {
                                DailyReviewCard(ui.reviewItems)
                            }
                        }
                        val sampleCount = ui.notes.count { SAMPLE_TAG in it.tags }
                        if (!ui.selectionMode && sampleCount > 0) {
                            item(key = "sample-banner") {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .border(
                                            1.dp,
                                            MaterialTheme.colorScheme.outlineVariant,
                                            RoundedCornerShape(12.dp),
                                        )
                                        .padding(horizontal = 12.dp, vertical = 4.dp),
                                ) {
                                    Text(
                                        "时间流里有 $sampleCount 条示例笔记（#$SAMPLE_TAG）",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.weight(1f),
                                    )
                                    TextButton(onClick = { vm.clearSamples() }) { Text("一键清除") }
                                }
                            }
                        }
                        items(ui.notes, key = { it.id }) { note ->
                            NoteCard(
                                note,
                                onToggleTodo = { vm.toggleTodo(it) },
                                onDelete = { vm.deleteNote(it) },
                                onToggleSensitive = { vm.toggleSensitive(it) },
                                onRetryLink = { vm.retryLink(it) },
                                retryingLink = note.id in ui.retryingLinkIds,
                                onDownloadFile = { vm.downloadFile(it) },
                                onEdit = { vm.openEditor(it) },
                                selectable = ui.selectionMode,
                                selected = note.id in ui.selectedIds,
                                onSelectToggle = { vm.toggleSelect(it) },
                                onLongPress = { vm.enterSelection(it) },
                                fetchMedia = vm::fetchMedia,
                            )
                        }
                        if (ui.loadingMore) {
                            item {
                                Row(
                                    Modifier.fillMaxWidth().padding(vertical = 8.dp),
                                    horizontalArrangement = Arrangement.Center,
                                ) { CircularProgressIndicator(Modifier.width(24.dp).height(24.dp)) }
                            }
                        }
                        item { Spacer(Modifier.height(24.dp)) }
                    }
                }
            }
        }
    }
}
