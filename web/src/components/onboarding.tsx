import {
  Sparkles,
  KeyRound,
  UserPlus,
  ChevronRight,
  MessageCircle,
  Scissors,
  Smartphone,
  Globe,
  Bot,
  PackageOpen,
} from "lucide-react"
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

const REPO = "https://github.com/wookat/suinian"

/** Cubox 速记 2027-05 停服；返回距停服还剩几个整月（不足一月计 0） */
export function monthsUntilCuboxShutdown(now: Date = new Date()): number {
  return Math.max(0, (2027 - now.getFullYear()) * 12 + (4 - now.getMonth()))
}

const CHANNELS = [
  // 微信官方通道尚未上线：登录前无法查询能力开关，按未开通的诚实文案展示（与设置页 fail-closed 口径一致）
  { icon: MessageCircle, label: "微信 bot", blurb: "即将上线 · 自部署可用 bridge", href: `${REPO}/tree/main/skill` },
  { icon: Scissors, label: "剪藏扩展", blurb: "网页选中一键收进碎念", href: `${REPO}/tree/main/extension` },
  { icon: Smartphone, label: "Android", blurb: "系统分享 + 桌面小组件", href: `${REPO}/tree/main/android` },
  { icon: Globe, label: "Web · PWA", blurb: "手机桌面装成 App", href: "#/" },
  { icon: Bot, label: "MCP", blurb: "Claude / Cursor 里直接读写", href: `${REPO}/blob/main/docs/mcp.md` },
] as const

export function Onboarding() {
  function choose(action: (typeof CHOICES)[number]["action"] | "import") {
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
      {/* dialog landmark：欢迎弹层内容全部落在地标内（axe region，audit-r263 P3-3） */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-xl border bg-card p-6 shadow-lg animate-in fade-in zoom-in-95 duration-300"
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            碎
          </span>
          <h2 id="onboarding-title" className="text-lg font-semibold">欢迎来到碎念</h2>
        </div>
        {/* R182 P2-3：首屏收敛为一句话主张，移动端不再被长段落撑出可视区 */}
        <p className="mb-1 text-sm font-medium">什么都能丢，AI 帮你想起来。</p>
        <p className="mb-2 text-xs text-muted-foreground">
          想法、链接、语音、账目随手丢进来，自动分拣打标签、串成思考线索，随时问随时找回。
        </p>
        {/* R230 P3-5：场景化示例让陌生用户 5 秒内建立「这是什么、对我有什么用」认知 */}
        <div className="mb-4 space-y-1 rounded-lg bg-secondary/50 p-2.5 text-xs">
          <p className="text-muted-foreground">
            「打车 34.5 其中退款 9」<span className="mx-0.5 text-foreground">→</span> 自动记账 25.5 元
          </p>
          <p className="text-muted-foreground">
            「周五前交房租」<span className="mx-0.5 text-foreground">→</span> 变成带期限的待办
          </p>
          <p className="text-muted-foreground">
            「上周存的那篇文章呢」<span className="mx-0.5 text-foreground">→</span> 问一句，AI 带引用找回
          </p>
        </div>
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

        <button
          onClick={() => choose("import")}
          className="mt-3 flex w-full items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-left transition-colors hover:bg-amber-500/20"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15">
            <PackageOpen className="size-4.5 text-amber-600 dark:text-amber-400" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Cubox / flomo 搬家？三步搬完</span>
            <span className="block text-xs text-muted-foreground">
              Cubox 速记 2027-05 停服（还剩约 {monthsUntilCuboxShutdown()} 个月）。导出文件 → 设置页一键导入 → 原时间与标签全保留，AI 自动补分拣、串线索
            </span>
          </span>
          <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
        </button>

        {/* 多端入口展示属于锦上添花，小屏隐藏以保证三个主入口首屏可见 */}
        <div className="mt-4 hidden sm:block">
          <p className="mb-2 text-xs font-medium text-muted-foreground">哪里都能丢进来</p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {CHANNELS.map((ch) => {
              const Icon = ch.icon
              return (
                <a
                  key={ch.label}
                  href={ch.href}
                  target={ch.href.startsWith("http") ? "_blank" : undefined}
                  rel="noreferrer"
                  className="rounded-lg border p-2 transition-colors hover:bg-accent"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <Icon className="size-3.5 shrink-0" />
                    {ch.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{ch.blurb}</span>
                </a>
              )
            })}
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          开源可自部署 · 数据在你自己的 Cloudflare 账号里 ·{" "}
          <a href={REPO} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            GitHub
          </a>
        </p>
      </div>
    </div>
  )
}
