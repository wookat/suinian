package com.zalize.suinian.ui.components

import android.graphics.Bitmap
import android.graphics.BitmapFactory

/** 卡片 / 全屏查看的解码上限（长边像素）：原图 12MP 整张解码是 48MB，按此上限最多约 12MB */
const val MEDIA_DECODE_MAX_DIM = 2048

/**
 * BitmapFactory.inSampleSize 只认 2 的幂：取最小的 2^k 使 max(w, h) / 2^k <= maxDim（上限是内存帽，宁小勿大）。
 * 边长未知（<= 0）时按 1
 */
fun sampleSizeFor(width: Int, height: Int, maxDim: Int): Int {
    if (width <= 0 || height <= 0 || maxDim <= 0) return 1
    var sample = 1
    val longest = maxOf(width, height)
    while (longest / sample > maxDim) sample *= 2
    return sample
}

/** 只读原图尺寸（不分配像素）；读不出为 (0, 0) */
fun decodeImageBounds(bytes: ByteArray): Pair<Int, Int> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    return bounds.outWidth to bounds.outHeight
}

/** 先只读尺寸，再按 inSampleSize 解码；解码失败返回 null */
fun decodeSampledBitmap(bytes: ByteArray, maxDim: Int = MEDIA_DECODE_MAX_DIM): Bitmap? {
    val (w, h) = decodeImageBounds(bytes)
    val opts = BitmapFactory.Options().apply {
        inSampleSize = sampleSizeFor(w, h, maxDim)
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}
