package com.zalize.suinian.ui.components

import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext

/**
 * 系统默认网络切换到可用（断网恢复、Wi-Fi ↔ 蜂窝切换）时回调，主线程执行。
 * registerDefaultNetworkCallback 对注册时已连接的网络会立刻回调一次，不算恢复，跳过。
 */
@Composable
fun OnNetworkAvailable(onAvailable: () -> Unit) {
    val context = LocalContext.current
    val current by rememberUpdatedState(onAvailable)
    DisposableEffect(context) {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val main = Handler(Looper.getMainLooper())
        var skipEcho = try {
            cm?.activeNetwork != null
        } catch (_: SecurityException) {
            false
        }
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (skipEcho) {
                    skipEcho = false
                    return
                }
                main.post { current() }
            }
        }
        val registered = try {
            cm?.registerDefaultNetworkCallback(cb)
            cm != null
        } catch (_: RuntimeException) {
            false
        }
        onDispose {
            if (registered) {
                try {
                    cm?.unregisterNetworkCallback(cb)
                } catch (_: RuntimeException) {
                }
            }
        }
    }
}
