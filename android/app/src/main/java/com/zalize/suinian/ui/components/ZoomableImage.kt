package com.zalize.suinian.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize

/**
 * 全屏看图：双指缩放（1–5 倍，以手指中心为轴）、放大后单指拖动（不拖出空白）、双击放大 / 复原、单击 [onTap]。
 * 换一张图（bitmap 变）时缩放复位。
 */
@Composable
fun ZoomableImage(
    bitmap: ImageBitmap,
    contentDescription: String?,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var scale by remember(bitmap) { mutableFloatStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(Offset.Zero) }
    var container by remember { mutableStateOf(IntSize.Zero) }

    fun clamped(o: Offset, s: Float): Offset {
        val (cw, ch) = fitContentSize(container.width.toFloat(), container.height.toFloat(), bitmap.width, bitmap.height)
        val (x, y) = clampPan(o.x, o.y, s, cw, ch, container.width.toFloat(), container.height.toFloat())
        return Offset(x, y)
    }
    fun center() = Offset(container.width / 2f, container.height / 2f)

    Image(
        bitmap = bitmap,
        contentDescription = contentDescription,
        contentScale = ContentScale.Fit,
        modifier = modifier
            .fillMaxSize()
            .onSizeChanged { container = it }
            .pointerInput(bitmap) {
                detectTapGestures(
                    onTap = { onTap() },
                    onDoubleTap = { tap ->
                        val ns = nextDoubleTapScale(scale)
                        val focus = tap - center()
                        val (x, y) = zoomAboutFocus(offset.x, offset.y, scale, ns, focus.x, focus.y)
                        offset = clamped(Offset(x, y), ns)
                        scale = ns
                    },
                )
            }
            .pointerInput(bitmap) {
                detectTransformGestures { centroid, pan, zoom, _ ->
                    val ns = (scale * zoom).coerceIn(1f, IMAGE_ZOOM_MAX)
                    val focus = centroid - center()
                    val (x, y) = zoomAboutFocus(offset.x, offset.y, scale, ns, focus.x, focus.y)
                    offset = clamped(Offset(x + pan.x, y + pan.y), ns)
                    scale = ns
                }
            }
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            },
    )
}
