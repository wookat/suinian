import { useEffect, useState } from "react"
import {
  Home,
  CheckSquare,
  GitBranch,
  FileText,
  Settings as SettingsIcon,
} from "lucide-react"
import { TimelinePage } from "@/pages/timeline"
import { TodosPage } from "@/pages/todos"
import { ThreadsPage, ReportsPage } from "@/pages/placeholders"
import { SettingsPage } from "@/pages/settings"
import { cn } from "@/lib/utils"

const ROUTES = [
  { path: "", label: "首页", icon: Home, page: TimelinePage },
  { path: "todos", label: "待办", icon: CheckSquare, page: TodosPage },
  { path: "threads", label: "线索", icon: GitBranch, page: ThreadsPage },
  { path: "reports", label: "周报", icon: FileText, page: ReportsPage },
  { path: "settings", label: "设置", icon: SettingsIcon, page: SettingsPage },
] as const

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash.replace(/^#\/?/, ""))
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.replace(/^#\/?/, ""))
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  return hash
}

export default function App() {
  const route = useHashRoute()
  const active = ROUTES.find((r) => r.path === route) ?? ROUTES[0]
  const Page = active.page

  return (
    <div className="min-h-dvh">
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

      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 md:pb-8 md:pl-[13.5rem] md:pr-6 lg:mx-auto lg:max-w-3xl">
        <Page />
      </main>

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
    </div>
  )
}
