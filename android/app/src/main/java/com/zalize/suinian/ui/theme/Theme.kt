package com.zalize.suinian.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// 品牌绿，对齐 Web 主色 oklch(0.55 0.14 155) ≈ #1F9D55
private val BrandGreen = Color(0xFF1F9D55)
private val BrandGreenDark = Color(0xFF5CCB8B) // Web 暗色主色 oklch(0.72 0.13 155)

private val LightColors = lightColorScheme(
    primary = BrandGreen,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFC9EDD6),
    onPrimaryContainer = Color(0xFF06371B),
    secondary = Color(0xFF4E6355),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFD1E8D6),
    onSecondaryContainer = Color(0xFF0B1F14),
    tertiary = Color(0xFF3B6470),
    surface = Color(0xFFFAFBF8),
    background = Color(0xFFFAFBF8),
    surfaceVariant = Color(0xFFE3EAE2),
    onSurfaceVariant = Color(0xFF41493F),
    outline = Color(0xFF71796F),
)

private val DarkColors = darkColorScheme(
    primary = BrandGreenDark,
    onPrimary = Color(0xFF04331A),
    primaryContainer = Color(0xFF135A32),
    onPrimaryContainer = Color(0xFFB2F1C8),
    secondary = Color(0xFFB5CCBB),
    onSecondary = Color(0xFF213528),
    secondaryContainer = Color(0xFF374B3E),
    onSecondaryContainer = Color(0xFFD1E8D6),
    tertiary = Color(0xFFA3CDDB),
    surface = Color(0xFF111411),
    background = Color(0xFF111411),
    surfaceVariant = Color(0xFF41493F),
    onSurfaceVariant = Color(0xFFC1C9BE),
    outline = Color(0xFF8B9389),
)

@Composable
fun SuinianTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // 视觉对齐 Web：固定品牌绿，不使用 Material You 动态取色
    val colorScheme = if (darkTheme) DarkColors else LightColors
    MaterialTheme(colorScheme = colorScheme, content = content)
}
