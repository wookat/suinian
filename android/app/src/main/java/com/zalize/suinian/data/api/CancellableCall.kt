package com.zalize.suinian.data.api

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import okhttp3.ResponseBody
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 挂起等待响应头；协程取消时 cancel() 整个 Call（阻塞式 execute() 不响应取消，会在 IO 线程继续跑完再丢掉） */
internal suspend fun Call.awaitResponse(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }

        override fun onResponse(call: Call, response: Response) {
            if (cont.isActive) cont.resume(response) else response.close()
        }
    })
    cont.invokeOnCancellation { cancel() }
}

/**
 * 阻塞读完整个响应体；协程取消时由哨兵 cancel() Call，让阻塞中的 read 立刻抛出而不是等到 readTimeout。
 * 取消导致的 IOException 不会漏出——先 ensureActive() 让取消以 CancellationException 出去。
 */
internal suspend fun ResponseBody.bytesCancellable(call: Call): ByteArray = coroutineScope {
    var finished = false
    val watcher = launch {
        try {
            awaitCancellation()
        } finally {
            if (!finished) call.cancel()
        }
    }
    try {
        val bytes = bytes()
        finished = true
        bytes
    } catch (e: IOException) {
        ensureActive()
        throw e
    } finally {
        watcher.cancel()
    }
}
