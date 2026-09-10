package com.zalize.suinian.ui.components

/**
 * 进程内同一时刻只放一段语音：新卡开播时把上一张暂停并通知它把按钮翻回「播放」。
 * 只在主线程（Compose 点击 / 完成回调）访问。
 */
object AudioPlaybackArbiter {
    private var owner: Any? = null
    private var onPreempted: (() -> Unit)? = null

    fun claim(newOwner: Any, preempted: () -> Unit) {
        if (owner != null && owner !== newOwner) onPreempted?.invoke()
        owner = newOwner
        onPreempted = preempted
    }

    fun release(who: Any) {
        if (owner === who) {
            owner = null
            onPreempted = null
        }
    }

    fun isHeldBy(who: Any): Boolean = owner === who
}
