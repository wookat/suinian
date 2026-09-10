import { Suspense, useEffect, useState } from "react"
import { AnimatePresence, LazyMotion, m, MotionConfig } from "motion/react"
import {
  Home,
  CheckSquare,
  GitBranch,
  FileText,
  BarChart3,
  Settings as SettingsIcon,
  Info,
  WifiOff,
  X,
  Search,
  Command as CommandIcon,
} from "lucide-react"
import { TimelinePage } from "@/pages/timeline"
import { ReloadPrompt } from "@/components/reload-prompt"
import { PageCopyGuard } from "@/components/exec-guard"
import { PageHeader } from "@/components/page-header"
import { RightRail } from "@/components/right-rail"
import { COMMAND_PALETTE_EVENT, openCommandPalette } from "@/lib/command-palette"
import { ChunkBoundary } from "@/components/chunk-boundary"
import { importRetry, lazyRetry } from "@/lib/lazy-retry"
import { TOAST_WANTED_EVENT } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings"
import { syncTimezone } from "@/lib/api"
import { cn } from "@/lib/utils"

// non-home pages are code-split: keeps the first-paint bundle to the timeline
const CommandPalette = lazyRetry(
  () => import("@/components/command-palette"),
  (m) => m.CommandPalette,
)
const Toaster = lazyRetry(
  () => import("@/components/ui/sonner"),
  (m) => m.Toaster,
)
// 动效特性包（motion domMax）不占首屏带宽：等 load 事件后再拉，之前 m.* 按静态元素渲染
const loadMotionFeatures = () =>
  new Promise<void>((resolve) => {
    if (document.readyState === "complete") window.setTimeout(resolve, 300)
    else window.addEventListener("load", () => window.setTimeout(resolve, 300), { once: true })
  }).then(() => importRetry(() => import("@/lib/motion-features")).then((mod) => mod.default))

const TodosPage = lazyRetry(
  () => import("@/pages/todos"),
  (m) => m.TodosPage,
)
const ThreadsPage = lazyRetry(
  () => import("@/pages/threads"),
  (m) => m.ThreadsPage,
)
const ReportsPage = lazyRetry(
  () => import("@/pages/reports"),
  (m) => m.ReportsPage,
)
const InsightsPage = lazyRetry(
  () => import("@/pages/insights"),
  (m) => m.InsightsPage,
)
const SettingsPage = lazyRetry(
  () => import("@/pages/settings"),
  (m) => m.SettingsPage,
)
const AuthPage = lazyRetry(
  () => import("@/pages/auth"),
  (m) => m.AuthPage,
)
const TrashPage = lazyRetry(
  () => import("@/pages/trash"),
  (m) => m.TrashPage,
)

const ROUTES = [
  {
    path: "",
    label: "首页",
    icon: Home,
    page: TimelinePage,
    title: "时间流",
    description: "随手一丢的碎念都在这里，AI 自动分拣与打标签",
  },
  {
    path: "todos",
    label: "待办",
    icon: CheckSquare,
    page: TodosPage,
    title: "待办",
    description: "从碎念里自动识别出的待办事项，按期限分组",
  },
  {
    path: "threads",
    label: "线索",
    icon: GitBranch,
    page: ThreadsPage,
    title: "思考线索",
    description: "相似想法自动串成的思考线索，看见想法如何生长",
  },
  {
    path: "reports",
    label: "报告",
    icon: FileText,
    page: ReportsPage,
    title: "思考报告",
    description: "周报每周一、月报每月 1 日自动生成，回顾「这段时间你在想什么」",
  },
  {
    path: "insights",
    label: "洞察",
    icon: BarChart3,
    page: InsightsPage,
    title: "洞察",
    description: "记录热力图、连续天数与全部笔记的统计全貌，随机漫步重遇旧想法",
  },
  {
    path: "settings",
    label: "设置",
    icon: SettingsIcon,
    page: SettingsPage,
    title: "设置",
    description: "数据源、外观与连接配置",
  },
] as const

function parseRoute(): string {
  return window.location.hash.replace(/^#\/?/, "").split("?")[0]
}

function useHashRoute(): string {
  const [hash, setHash] = useState(parseRoute)
  useEffect(() => {
    const onChange = () => setHash(parseRoute())
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  return hash
}

function useMockMode(): boolean {
  const [mock, setMock] = useState(() => loadSettings().useMock)
  useEffect(() => {
    const onChange = () => setMock(loadSettings().useMock)
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    window.addEventListener("storage", onChange)
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
      window.removeEventListener("storage", onChange)
    }
  }, [])
  return mock
}

// 双导航只露出当前断点可见的那一套（R196 P3-1）：侧栏与底栏同在 DOM（仅 CSS
// 隐藏其一）会让 aria-current="page" 每路由命中 2 个元素；隐藏侧 aria-hidden。
function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)")
    const onChange = () => setDesktop(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return desktop
}

// 全局离线状态（R220 P3-1，audit-r219：PWA 离线刷新只有送笔记时才知道断网）：
// 断网时顶部常驻提示可继续记录、历史页面可能是缓存，不等用户操作才发现
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const onUp = () => setOnline(true)
    const onDown = () => setOnline(false)
    window.addEventListener("online", onUp)
    window.addEventListener("offline", onDown)
    return () => {
      window.removeEventListener("online", onUp)
      window.removeEventListener("offline", onDown)
    }
  }, [])
  return online
}

// off-nav route: 最近删除 recycle bin (linked from settings)
const TRASH_ROUTE = {
  path: "trash",
  label: "最近删除",
  icon: SettingsIcon,
  page: TrashPage,
  title: "最近删除",
  description: "已删除笔记的暂存处，可以恢复或立即彻底删除",
} as const

// off-nav route: register/login (linked from onboarding & settings)
const AUTH_ROUTE = {
  path: "auth",
  label: "注册 / 登录",
  icon: SettingsIcon,
  page: AuthPage,
  title: "注册 / 登录",
  description: "注册新账号或用密码登录，自动配置 API token",
} as const

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/** 命令面板（cmdk）与 Toaster（sonner）不进首屏：空闲时加载，或用户首次⌘K / 点击搜索时立即加载 */
function useDeferredUiReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (ready) return
    const markReady = () => setReady(true)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        openCommandPalette()
      }
    }
    window.addEventListener(COMMAND_PALETTE_EVENT, markReady)
    window.addEventListener(TOAST_WANTED_EVENT, markReady)
    window.addEventListener("keydown", onKey)
    const idle = window.setTimeout(markReady, 1500)
    return () => {
      window.removeEventListener(COMMAND_PALETTE_EVENT, markReady)
      window.removeEventListener(TOAST_WANTED_EVENT, markReady)
      window.removeEventListener("keydown", onKey)
      window.clearTimeout(idle)
    }
  }, [ready])
  return ready
}

/* 懒加载页面分包下载期间给出骨架占位：fallback=null 会让首次进入的页面
   （如 #/auth 表单）空白数秒（R232 P3-4，audit-r231 §9） */
function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="页面加载中" className="space-y-3 pt-1">
      <Skeleton className="h-9 w-full max-w-sm" />
      <Skeleton className="h-9 w-full max-w-sm" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

/** 页面分包下载失败（多半是断网 / 切网时切页）或页面渲染抛错时的可恢复占位 */
function PageLoadError({ chunk, retry }: { chunk: boolean; retry: () => void }) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false
  return (
    <div role="alert" className="space-y-3 rounded-xl border bg-card p-5 text-sm">
      <p className="font-medium">{chunk ? "这个页面的代码没能下载完成" : "这个页面出错了"}</p>
      <p className="text-muted-foreground">
        {chunk
          ? offline
            ? "当前处于离线状态，且这个页面尚未缓存到本机。联网后点「重新加载」即可。"
            : "多半是网络刚刚中断或切换过。浏览器要整页重新加载才能补下这部分代码，点「重新加载」即可。"
          : "可以重试一次；若持续出错，请刷新页面。"}
      </p>
      <div className="flex flex-wrap gap-2">
        {chunk ? (
          <Button size="sm" onClick={() => window.location.reload()}>
            重新加载
          </Button>
        ) : (
          <Button size="sm" onClick={retry}>
            重试
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => (window.location.hash = "#/")}>
          回到首页
        </Button>
      </div>
    </div>
  )
}

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[color-mix(in_oklch,var(--color-primary)_70%,var(--color-chart-2))] font-bold text-primary-foreground shadow-sm",
        className,
      )}
    >
      碎
    </span>
  )
}

/** 已完成引导后的完整应用外壳（导航/命令面板/动效运行时）；未引导时由 App 直接渲染欢迎页，本模块不进首屏 */
export function AppShell() {
  const route = useHashRoute()
  const active =
    route === AUTH_ROUTE.path
      ? AUTH_ROUTE
      : route === TRASH_ROUTE.path
        ? TRASH_ROUTE
        : (ROUTES.find((r) => r.path === route) ?? ROUTES[0])
  const Page = active.page
  const isMock = useMockMode()
  const isDesktop = useIsDesktop()
  const online = useOnline()
  const deferredReady = useDeferredUiReady()

  // 浏览器时区同步到服务端偏好：首次加载 + 注册/登录（settings 变更）后
  useEffect(() => {
    void syncTimezone()
    const onChange = () => void syncTimezone()
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures}>
        <TooltipProvider>
          <div className="min-h-dvh">
            {/* skip link：hash 路由下不能真跳 anchor（会改写路由），改为直接把焦点移到主内容 */}
            <a
              href="#main-content"
              onClick={(e) => {
                e.preventDefault()
                document.getElementById("main-content")?.focus()
              }}
              className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:inline-flex focus:min-h-6 focus:min-w-6 focus:items-center"
            >
              跳过导航，直达主要内容
            </a>
            {!online && (
              <div
                role="status"
                className="flex items-center justify-center gap-2 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground backdrop-blur md:pl-56 print:hidden"
              >
                <WifiOff className="size-4 shrink-0" />
                <span>当前离线：可继续记录（会暂存本机、联网后自动补发），页面内容可能是缓存</span>
              </div>
            )}
            {isMock && (
              <div
                role="region"
                aria-label="演示模式提示"
                className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/12 px-3 py-2 text-[13px] text-amber-800 backdrop-blur sm:px-4 sm:text-sm dark:text-amber-300 md:pl-56"
              >
                <Info className="size-4 shrink-0" />
                <span className="min-w-0">
                  当前为演示数据，
                  <a href="#/settings" className="font-medium underline underline-offset-2">
                    去设置连接你的碎念&nbsp;→
                  </a>
                </span>
                <button
                  onClick={() => {
                    saveSettings({ ...loadSettings(), useMock: false })
                    window.location.reload()
                  }}
                  aria-label="关闭演示模式"
                  className="ml-1 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-amber-500/40 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-amber-500/20"
                >
                  <X className="size-3" /> 关闭演示
                </button>
              </div>
            )}

            {/* Desktop sidebar */}
            <aside
              aria-label="导航侧栏"
              aria-hidden={isDesktop ? undefined : true}
              className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r bg-card/80 p-3 backdrop-blur-xl md:flex print:hidden"
            >
              <a href="#/" className="mb-4 flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-secondary">
                <BrandMark className="size-8 text-sm" />
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold leading-tight tracking-tight">碎念</h1>
                  <p className="text-[11px] leading-tight text-muted-foreground">AI 收件箱</p>
                </div>
              </a>
              <button
                type="button"
                onClick={openCommandPalette}
                className="mb-3 flex h-9 items-center gap-2 rounded-lg border border-input bg-background/60 px-2.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-background hover:text-foreground"
              >
                <Search className="size-4" />
                <span className="flex-1 text-left">搜索或跳转…</span>
                <kbd className="inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground">
                  {isMac ? <CommandIcon className="size-2.5" /> : "Ctrl"}K
                </kbd>
              </button>
              <nav aria-label="侧栏导航" className="flex flex-col gap-0.5">
                {ROUTES.map((r) => {
                  const Icon = r.icon
                  const isActive = active.path === r.path
                  return (
                    <a
                      key={r.path}
                      href={`#/${r.path}`}
                      aria-current={isDesktop && isActive ? "page" : undefined}
                      className={cn(
                        "relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
                        isActive ? "text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      {isActive && (
                        <m.span
                          layoutId="sidebar-active"
                          aria-hidden
                          className="absolute inset-0 rounded-lg bg-accent"
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                        />
                      )}
                      <Icon className={cn("relative size-4", isActive && "text-primary")} />
                      <span className="relative">{r.label}</span>
                    </a>
                  )
                })}
              </nav>
              <div className="mt-auto px-2 pb-1 text-[11px] leading-relaxed text-muted-foreground">
                随手一丢，AI 自动整理。
              </div>
            </aside>

            {/* Mobile top bar */}
            <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b bg-background/85 px-4 py-2.5 backdrop-blur-xl md:hidden print:hidden">
              <BrandMark className="size-7 rounded-lg text-xs" />
              <h1 className="flex-1 truncate text-[15px] font-semibold tracking-tight">
                {active.path === "" ? "碎念" : active.label}
              </h1>
              <button
                type="button"
                onClick={openCommandPalette}
                aria-label="搜索或跳转"
                className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Search className="size-[18px]" />
              </button>
            </header>

            <div className="md:pl-56 print:pl-0">
              <div className="mx-auto flex max-w-2xl gap-10 px-4 pb-28 pt-4 md:px-8 md:pb-10 md:pt-8 lg:max-w-3xl xl:max-w-6xl">
                <AnimatePresence mode="wait" initial={false}>
                  <m.main
                    key={active.path}
                    id="main-content"
                    tabIndex={-1}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
                    className="min-w-0 flex-1 space-y-6 outline-none xl:max-w-3xl"
                  >
                    <PageHeader title={active.title} description={active.description} />
                    <ChunkBoundary
                      resetKey={active.path}
                      fallback={({ chunk, retry }) => <PageLoadError chunk={chunk} retry={retry} />}
                    >
                      <Suspense fallback={<PageSkeleton />}>
                        <Page />
                      </Suspense>
                    </ChunkBoundary>
                  </m.main>
                </AnimatePresence>
                <aside aria-label="辅助信息栏" className="hidden w-72 shrink-0 pt-1 xl:block print:hidden">
                  <div className="sticky top-8">
                    <RightRail />
                  </div>
                </aside>
              </div>
            </div>

            {/* Mobile bottom nav */}
            <nav
              aria-label="底部导航"
              aria-hidden={isDesktop ? true : undefined}
              className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-card/90 px-1 backdrop-blur-xl md:hidden print:hidden"
            >
              {ROUTES.map((r) => {
                const Icon = r.icon
                const isActive = active.path === r.path
                return (
                  <a
                    key={r.path}
                    href={`#/${r.path}`}
                    aria-current={!isDesktop && isActive ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 pb-[env(safe-area-inset-bottom)] text-[11px] font-medium transition-colors",
                      isActive ? "text-primary" : "text-muted-foreground active:text-foreground",
                    )}
                  >
                    <span className="relative flex h-7 w-12 items-center justify-center">
                      {isActive && (
                        <m.span
                          layoutId="bottomnav-active"
                          aria-hidden
                          className="absolute inset-0 rounded-full bg-primary/12"
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                        />
                      )}
                      <Icon className="relative size-[22px]" strokeWidth={isActive ? 2.25 : 1.75} />
                    </span>
                    {r.label}
                  </a>
                )
              })}
            </nav>

            {deferredReady && (
              // 命令面板 / toast 是增强件：分包拉不下来就静默不渲染，不能拖垮整个外壳
              <ChunkBoundary fallback={() => null}>
                <Suspense fallback={null}>
                  <CommandPalette routes={ROUTES} />
                  <Toaster />
                </Suspense>
              </ChunkBoundary>
            )}
            <ReloadPrompt />
            <PageCopyGuard />
          </div>
        </TooltipProvider>
      </LazyMotion>
    </MotionConfig>
  )
}
