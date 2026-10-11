import { Suspense, useEffect, useState } from "react"
import { Onboarding } from "@/components/onboarding"
import { ChunkBoundary } from "@/components/chunk-boundary"
import { lazyRetry } from "@/lib/lazy-retry"
import { loadSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings"

/**
 * 首屏门禁（R337 体积优化）：入口分包只带 React + 欢迎页；完整外壳（Radix/motion/时间流）
 * 独立分包，已引导用户由 index.html 里的 boot 脚本按 localStorage 提前 modulepreload，
 * 与入口并行下载；首次访客则在欢迎页空闲时预热，选择入口后即刻可用。
 */
// app-shell 是所有页面分包的共享依赖，不是叶子：失败只能整页重载（见 lazyRetry 注释）
const AppShell = lazyRetry(
  () => import("@/app-shell"),
  (m) => m.AppShell,
  { leaf: false },
)
const preloadShell = () => void import("@/app-shell")

function useOnboarded(): boolean {
  const [onboarded, setOnboarded] = useState(() => loadSettings().onboarded)
  useEffect(() => {
    const onChange = () => setOnboarded(loadSettings().onboarded)
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    window.addEventListener("storage", onChange)
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
      window.removeEventListener("storage", onChange)
    }
  }, [])
  return onboarded
}

export default function App() {
  const onboarded = useOnboarded()
  if (!onboarded) return <Onboarding onIdle={preloadShell} />
  // fallback=null 让 #root 保持 :empty，index.html 内联骨架继续显示直到外壳就绪
  return (
    <ChunkBoundary fallback={({ chunk }) => <ShellLoadError chunk={chunk} />}>
      <Suspense fallback={null}>
        <AppShell />
      </Suspense>
    </ChunkBoundary>
  )
}

/** 外壳分包拉不下来（首次访问时断网）或外壳渲染抛错：纯 HTML，不带 UI 库进首屏分包 */
function ShellLoadError({ chunk }: { chunk: boolean }) {
  return (
    <div role="alert" style={{ maxWidth: 420, margin: "20vh auto", padding: "0 24px", fontSize: 14, lineHeight: 1.7 }}>
      <p style={{ fontWeight: 600, marginBottom: 8 }}>{chunk ? "碎念没能加载完成" : "碎念遇到了一个错误"}</p>
      <p style={{ opacity: 0.75, marginBottom: 16 }}>
        {chunk ? "多半是网络中断。请确认已联网后重新加载。" : "重新加载通常可以恢复。"}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid currentColor", background: "transparent", color: "inherit", cursor: "pointer" }}
      >
        重新加载
      </button>
    </div>
  )
}
