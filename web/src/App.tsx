import { lazy, Suspense, useEffect, useState } from "react"
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
} from "lucide-react"
import { TimelinePage } from "@/pages/timeline"
import { Onboarding } from "@/components/onboarding"
import { ReloadPrompt } from "@/components/reload-prompt"
import { PageCopyGuard } from "@/components/exec-guard"
import { PageHeader } from "@/components/page-header"
import { RightRail } from "@/components/right-rail"
import { Skeleton } from "@/components/ui/skeleton"
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings"
import { syncTimezone } from "@/lib/api"
import { cn } from "@/lib/utils"

// non-home pages are code-split: keeps the first-paint bundle to the timeline
const TodosPage = lazy(() => import("@/pages/todos").then((m) => ({ default: m.TodosPage })))
const ThreadsPage = lazy(() => import("@/pages/threads").then((m) => ({ default: m.ThreadsPage })))
const ReportsPage = lazy(() => import("@/pages/reports").then((m) => ({ default: m.ReportsPage })))
const InsightsPage = lazy(() => import("@/pages/insights").then((m) => ({ default: m.InsightsPage })))
const SettingsPage = lazy(() => import("@/pages/settings").then((m) => ({ default: m.SettingsPage })))
const AuthPage = lazy(() => import("@/pages/auth").then((m) => ({ default: m.AuthPage })))
const TrashPage = lazy(() => import("@/pages/trash").then((m) => ({ default: m.TrashPage })))

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
  const route = useHashRoute()
  const active =
    route === AUTH_ROUTE.path
      ? AUTH_ROUTE
      : route === TRASH_ROUTE.path
        ? TRASH_ROUTE
        : (ROUTES.find((r) => r.path === route) ?? ROUTES[0])
  const Page = active.page
  const isMock = useMockMode()
  const onboarded = useOnboarded()
  const isDesktop = useIsDesktop()
  const online = useOnline()

  // 浏览器时区同步到服务端偏好：首次加载 + 注册/登录（settings 变更）后
  useEffect(() => {
    void syncTimezone()
    const onChange = () => void syncTimezone()
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
  }, [])

  return (
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
      {!onboarded && <Onboarding />}
      {!online && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 border-b border-slate-500/30 bg-slate-500/15 px-4 py-2 text-sm text-slate-700 backdrop-blur dark:text-slate-300 md:pl-52 print:hidden"
        >
          <WifiOff className="size-4 shrink-0" />
          <span>当前离线：可继续记录（会暂存本机、联网后自动补发），页面内容可能是缓存</span>
        </div>
      )}
      {isMock && (
        <div
          role="region"
          aria-label="演示模式提示"
          className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-800 backdrop-blur dark:text-amber-300 md:pl-52">
          <Info className="size-4 shrink-0" />
          <span>
            当前为演示数据，
            <a href="#/settings" className="font-medium underline underline-offset-2">
              去设置连接你的碎念 →
            </a>
          </span>
          <button
            onClick={() => {
              saveSettings({ ...loadSettings(), useMock: false })
              window.location.reload()
            }}
            aria-label="关闭演示模式"
            className="ml-1 flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-amber-500/20"
          >
            <X className="size-3" /> 关闭演示
          </button>
        </div>
      )}
      {/* Desktop sidebar */}
      <aside
        aria-label="导航侧栏"
        aria-hidden={isDesktop ? undefined : true}
        className="fixed inset-y-0 left-0 z-20 hidden w-52 flex-col border-r bg-card p-4 md:flex print:hidden"
      >
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            碎
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight">碎念</h1>
            <p className="text-xs text-muted-foreground">AI 收件箱</p>
          </div>
        </div>
        <nav aria-label="侧栏导航" className="space-y-1">
          {ROUTES.map((r) => {
            const Icon = r.icon
            return (
              <a
                key={r.path}
                href={`#/${r.path}`}
                aria-current={isDesktop && active.path === r.path ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active.path === r.path
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {r.label}
              </a>
            )
          })}
        </nav>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur md:hidden print:hidden">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          碎
        </span>
        <h1 className="text-base font-semibold">{active.path === "" ? "碎念" : active.label}</h1>
      </header>

      <div className="md:pl-52 print:pl-0">
        <div className="mx-auto flex max-w-2xl gap-8 px-4 pb-24 pt-4 md:pb-8 md:pt-6 lg:max-w-3xl xl:max-w-6xl">
          <main
            key={active.path}
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 space-y-5 outline-none animate-in fade-in duration-300 xl:max-w-3xl"
          >
            <PageHeader title={active.title} description={active.description} />
            {/* 懒加载页面分包下载期间给出骨架占位：fallback=null 会让
                首次进入的页面（如 #/auth 表单）空白数秒（R232 P3-4，
                audit-r231 §9） */}
            <Suspense
              fallback={
                <div aria-busy="true" aria-label="页面加载中" className="space-y-3 pt-1">
                  <Skeleton className="h-9 w-full max-w-sm" />
                  <Skeleton className="h-9 w-full max-w-sm" />
                  <Skeleton className="h-24 w-full" />
                </div>
              }
            >
              <Page />
            </Suspense>
          </main>
          <aside aria-label="辅助信息栏" className="hidden w-72 shrink-0 pt-1 xl:block print:hidden">
            <div className="sticky top-6">
              <RightRail />
            </div>
          </aside>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav
        aria-label="底部导航"
        aria-hidden={isDesktop ? true : undefined}
        className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-card/95 backdrop-blur md:hidden print:hidden"
      >
        {ROUTES.map((r) => {
          const Icon = r.icon
          return (
            <a
              key={r.path}
              href={`#/${r.path}`}
              aria-current={!isDesktop && active.path === r.path ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-[11px] font-medium transition-colors",
                active.path === r.path ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="size-5" />
              {r.label}
            </a>
          )
        })}
      </nav>

      <ReloadPrompt />
      <PageCopyGuard />
    </div>
  )
}
