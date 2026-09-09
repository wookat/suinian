import { lazy, Suspense, useEffect, useState } from "react"
import { Onboarding } from "@/components/onboarding"
import { loadSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings"

/**
 * 首屏门禁（R337 体积优化）：入口分包只带 React + 欢迎页；完整外壳（Radix/motion/时间流）
 * 独立分包，已引导用户由 index.html 里的 boot 脚本按 localStorage 提前 modulepreload，
 * 与入口并行下载；首次访客则在欢迎页空闲时预热，选择入口后即刻可用。
 */
const AppShell = lazy(() => import("@/app-shell").then((mod) => ({ default: mod.AppShell })))
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
    <Suspense fallback={null}>
      <AppShell />
    </Suspense>
  )
}
