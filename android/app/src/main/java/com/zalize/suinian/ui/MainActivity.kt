package com.zalize.suinian.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.lifecycle.lifecycleScope
import com.zalize.suinian.SuinianApp
import com.zalize.suinian.notif.QuickNoteNotification
import com.zalize.suinian.ui.theme.SuinianTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    companion object {
        /** widget/通知点开时聚焦速记框 */
        const val EXTRA_FOCUS_QUICK_NOTE = "focus_quick_note"
    }

    private var focusQuickNoteSignal by mutableStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (intent?.getBooleanExtra(EXTRA_FOCUS_QUICK_NOTE, false) == true) focusQuickNoteSignal++
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 0)
        }
        setContent {
            SuinianTheme {
                SuinianNavHost(focusQuickNoteSignal)
            }
        }
    }

    @Deprecated("Deprecated in ComponentActivity")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val app = application as SuinianApp
        lifecycleScope.launch {
            if (app.settings.settings.first().notificationShortcut) {
                QuickNoteNotification.show(this@MainActivity)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_FOCUS_QUICK_NOTE, false)) focusQuickNoteSignal++
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun SuinianNavHost(focusQuickNoteSignal: Int) {
    val navController = rememberNavController()
    val vm: NotesViewModel = viewModel()
    val snackbarHostState = remember { SnackbarHostState() }
    val ui by vm.ui.collectAsState()

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        vm.refresh()
    }

    LaunchedEffect(ui.toast) {
        ui.toast?.let {
            snackbarHostState.showSnackbar(it)
            vm.consumeToast()
        }
    }

    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text("碎念", fontWeight = FontWeight.SemiBold) },
                        actions = {
                            IconButton(onClick = { navController.navigate("settings") }) {
                                Icon(Icons.Outlined.Settings, contentDescription = "设置")
                            }
                        },
                    )
                },
                snackbarHost = { SnackbarHost(snackbarHostState) },
            ) { padding ->
                HomeScreen(
                    vm = vm,
                    modifier = Modifier.padding(padding),
                    focusQuickNoteSignal = focusQuickNoteSignal,
                )
            }
        }
        composable("settings") {
            SettingsScreen(vm = vm, onBack = { navController.popBackStack() })
        }
    }
}
