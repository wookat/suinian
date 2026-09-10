package com.zalize.suinian.ui.components

/** 全屏看图的缩放 / 平移纯函数（不依赖 Compose 类型，便于 JVM 单测） */

const val IMAGE_ZOOM_MAX = 5f

/** 双击在原大与放大之间切换 */
fun nextDoubleTapScale(current: Float): Float = if (current > 1.01f) 1f else 2.5f

/**
 * ContentScale.Fit 下图片在容器里的显示尺寸（未缩放时）
 */
fun fitContentSize(containerW: Float, containerH: Float, imgW: Int, imgH: Int): Pair<Float, Float> {
    if (containerW <= 0f || containerH <= 0f || imgW <= 0 || imgH <= 0) return 0f to 0f
    val s = minOf(containerW / imgW, containerH / imgH)
    return imgW * s to imgH * s
}

/**
 * 平移夹紧：放大后的图任一边比容器长时可以拖到边贴边、不能拖出空白；比容器短的那一轴居中不动。
 * 变换以容器中心为原点（graphicsLayer 默认 transformOrigin）。
 */
fun clampPan(
    x: Float,
    y: Float,
    scale: Float,
    contentW: Float,
    contentH: Float,
    containerW: Float,
    containerH: Float,
): Pair<Float, Float> {
    val maxX = ((contentW * scale - containerW) / 2f).coerceAtLeast(0f)
    val maxY = ((contentH * scale - containerH) / 2f).coerceAtLeast(0f)
    return x.coerceIn(-maxX, maxX) to y.coerceIn(-maxY, maxY)
}

/**
 * 以手指所在点为中心缩放：保持该点下的图像内容不动。
 * [focusX]/[focusY] 是相对容器中心的坐标；返回新的平移量（未夹紧）。
 */
fun zoomAboutFocus(
    offsetX: Float,
    offsetY: Float,
    oldScale: Float,
    newScale: Float,
    focusX: Float,
    focusY: Float,
): Pair<Float, Float> {
    if (oldScale <= 0f) return offsetX to offsetY
    val r = newScale / oldScale
    return (focusX - (focusX - offsetX) * r) to (focusY - (focusY - offsetY) * r)
}

/** 全屏解码上限：屏幕长边的 2 倍（放大 2 倍仍清晰），夹在卡片上限与 GPU 纹理常见上限 4096 之间 */
fun fullscreenDecodeMaxDim(screenW: Int, screenH: Int): Int =
    (maxOf(screenW, screenH) * 2).coerceIn(MEDIA_DECODE_MAX_DIM, 4096)

/** 卡片那张按 [cardMaxDim] 采样过；只有全屏上限能少采样一档以上时才值得再解一次 */
fun fullscreenNeedsRedecode(imgW: Int, imgH: Int, cardMaxDim: Int, fullMaxDim: Int): Boolean =
    sampleSizeFor(imgW, imgH, fullMaxDim) < sampleSizeFor(imgW, imgH, cardMaxDim)
