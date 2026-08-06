package com.zalize.suinian.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

// 轻盈克制的绿调（参考 flomo 的沉静感）
private val LightColors = lightColorScheme(
    primary = Color(0xFF3A5A40),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD5E8D4),
    onPrimaryContainer = Color(0xFF102414),
    secondary = Color(0xFF52634F),
    secondaryContainer = Color(0xFFD5E8CF),
    surface = Color(0xFFFBFBF6),
    background = Color(0xFFFBFBF6),
    surfaceVariant = Color(0xFFE7EAE0),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA1CFA6),
    onPrimary = Color(0xFF0B3313),
    primaryContainer = Color(0xFF24422A),
    onPrimaryContainer = Color(0xFFBDEBC1),
    secondary = Color(0xFFB9CCB4),
    surface = Color(0xFF121411),
    background = Color(0xFF121411),
    surfaceVariant = Color(0xFF424940),
)

@Composable
fun SuinianTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        darkTheme -> DarkColors
        else -> LightColors
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}
