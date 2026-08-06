import { useEffect, useState } from "react"
import {
  Home,
  CheckSquare,
  GitBranch,
  FileText,
  Settings as SettingsIcon,
  Info,
  X,
} from "lucide-react"
import { TimelinePage } from "@/pages/timeline"
import { TodosPage } from "@/pages/todos"
import { ThreadsPage } from "@/pages/threads"
import { ReportsPage } from "@/pages/reports"
import { SettingsPage } from "@/pages/settings"
import { ReloadPrompt } from "@/components/reload-prompt"
import { PageHeader } from "@/components/page-header"
import { RightRail } from "@/components/right-rail"
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from "@/lib/settings"
import { cn } from "@/lib/utils"

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
    label: "周报",
    icon: FileText,
    page: ReportsPage,
    title: "每周思考报告",
    description: "每周一自动生成，回顾「本周你在想什么」",
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

export default function App() {
  const route = useHashRoute()
  const active = ROUTES.find((r) => r.path === route) ?? ROUTES[0]
  const Page = active.page
  const isMock = useMockMode()

  return (
    <div className="min-h-dvh">
      {isMock && (
        <div className="flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-800 backdrop-blur dark:text-amber-300 md:pl-52">
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
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-52 flex-col border-r bg-card p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            碎
          </span>
          <div>
            <h1 className="text-sm font-semibold leading-tight">碎念</h1>
            <p className="text-xs text-muted-foreground">AI 收件箱</p>
          </div>
        </div>
        <nav className="space-y-1">
          {ROUTES.map((r) => {
            const Icon = r.icon
            return (
              <a
                key={r.path}
                href={`#/${r.path}`}
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
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur md:hidden">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          碎
        </span>
        <h1 className="text-base font-semibold">{active.path === "" ? "碎念" : active.label}</h1>
      </header>

      <div className="md:pl-52">
        <div className="mx-auto flex max-w-2xl gap-8 px-4 pb-24 pt-4 md:pb-8 md:pt-6 lg:max-w-3xl xl:max-w-6xl">
          <main
            key={active.path}
            className="min-w-0 flex-1 space-y-5 animate-in fade-in duration-300 xl:max-w-3xl"
          >
            <PageHeader title={active.title} description={active.description} />
            <Page />
          </main>
          <aside className="hidden w-72 shrink-0 pt-1 xl:block">
            <div className="sticky top-6">
              <RightRail />
            </div>
          </aside>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-card/95 backdrop-blur md:hidden">
        {ROUTES.map((r) => {
          const Icon = r.icon
          return (
            <a
              key={r.path}
              href={`#/${r.path}`}
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
    </div>
  )
}
