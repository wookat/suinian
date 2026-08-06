package com.zalize.suinian.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

private data class Tab(
    val route: String,
    val label: String,
    val icon: ImageVector,
)

private val tabs = listOf(
    Tab("home", "碎念", Icons.AutoMirrored.Outlined.Notes),
    Tab("todos", "待办", Icons.Outlined.CheckCircle),
    Tab("threads", "线索", Icons.Outlined.AccountTree),
    Tab("reports", "周报", Icons.Outlined.Description),
)

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
        // 通知权限不在首启请求，改为设置里打开「通知栏速记入口」时再请求
        setContent {
            com.zalize.suinian.ui.theme.SuinianTheme {
                SuinianNavHost(focusQuickNoteSignal)
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

    // 小组件/通知点开：回到首页并聚焦速记框
    LaunchedEffect(focusQuickNoteSignal) {
        if (focusQuickNoteSignal > 0) {
            navController.navigate("home") {
                popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val showBottomBar = currentRoute in tabs.map { it.route }

    Scaffold(
        topBar = {
            if (showBottomBar) {
                TopAppBar(
                    title = {
                        Text(
                            when (currentRoute) {
                                "todos" -> "待办"
                                "threads" -> "思考线索"
                                "reports" -> "每周报告"
                                else -> "碎念"
                            },
                            fontWeight = FontWeight.SemiBold,
                        )
                    },
                    actions = {
                        IconButton(onClick = { navController.navigate("settings") }) {
                            Icon(Icons.Outlined.Settings, contentDescription = "设置")
                        }
                    },
                )
            }
        },
        bottomBar = {
            if (showBottomBar) {
                NavigationBar {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = currentRoute == tab.route,
                            onClick = {
                                navController.navigate(tab.route) {
                                    popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            },
                            icon = { Icon(tab.icon, contentDescription = tab.label) },
                            label = { Text(tab.label) },
                        )
                    }
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = "home",
            modifier = Modifier.padding(padding),
        ) {
            composable("home") {
                HomeScreen(
                    vm = vm,
                    focusQuickNoteSignal = focusQuickNoteSignal,
                )
            }
            composable("todos") {
                TodosScreen()
            }
            composable("threads") {
                ThreadsScreen(onOpenThread = { id -> navController.navigate("threads/$id") })
            }
            composable("threads/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ThreadDetailScreen(threadId = id, onBack = { navController.popBackStack() })
            }
            composable("reports") {
                ReportsScreen(onOpenReport = { id -> navController.navigate("reports/$id") })
            }
            composable("reports/{id}") { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ReportDetailScreen(reportId = id, onBack = { navController.popBackStack() })
            }
            composable("settings") {
                SettingsScreen(vm = vm, onBack = { navController.popBackStack() })
            }
        }
    }
}
