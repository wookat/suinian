import { Sparkles, KeyRound, UserPlus, ChevronRight } from "lucide-react"
import { loadSettings, saveSettings } from "@/lib/settings"

const CHOICES = [
  {
    icon: Sparkles,
    title: "先看看演示",
    description: "本地示例数据，无需账号即可体验完整界面",
    action: "demo",
  },
  {
    icon: UserPlus,
    title: "注册新账号",
    description: "用户名 + 密码，注册后自动配置，直接开始记录",
    action: "register",
  },
  {
    icon: KeyRound,
    title: "我已有 API token",
    description: "在设置页填入 API 地址与 token 即可连接",
    action: "token",
  },
] as const

export function Onboarding() {
  function choose(action: (typeof CHOICES)[number]["action"]) {
    if (action === "demo") {
      saveSettings({ ...loadSettings(), useMock: true, onboarded: true })
    } else if (action === "register") {
      saveSettings({ ...loadSettings(), onboarded: true })
      window.location.hash = "#/auth"
    } else {
      saveSettings({ ...loadSettings(), onboarded: true })
      window.location.hash = "#/settings"
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-lg animate-in fade-in zoom-in-95 duration-300">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            碎
          </span>
          <h2 className="text-lg font-semibold">欢迎来到碎念</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          什么都能丢的 AI 收件箱：随手一丢，AI 分拣、串线索、每周报告。先选一个开始方式：
        </p>
        <div className="space-y-2">
          {CHOICES.map((c) => {
            const Icon = c.icon
            return (
              <button
                key={c.action}
                onClick={() => choose(c.action)}
                className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <Icon className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">{c.description}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
