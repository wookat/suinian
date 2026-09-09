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
import { useEffect } from "react"
import { loadSettings, saveSettings } from "@/lib/settings"
import { KNOWN_ISSUES_URL, SAFETY_PROMISE_SHORT } from "@/lib/copy"

const CHOICES = [
  {
    icon: Sparkles,
    title: "先看看演示",
    description: "本地示例数据，无需账号即可体验完整界面",
    action: "demo",
    primary: false,
  },
  {
    icon: UserPlus,
    title: "注册新账号",
    description: "用户名 + 密码，注册后自动配置，直接开始记录",
    action: "register",
    primary: true,
  },
  {
    icon: KeyRound,
    title: "我已有 API token",
    description: "在设置页填入 API 地址与 token 即可连接",
    action: "token",
    primary: false,
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

const EXAMPLES = [
  { input: "打车 34.5 其中退款 9", output: "自动记账 25.5 元" },
  { input: "周五前交房租", output: "变成带期限的待办" },
  { input: "上周存的那篇文章呢", output: "问一句，AI 带引用找回" },
] as const

/**
 * 欢迎门禁：未引导时作为整页渲染（背后没有外壳，也就无从关闭/绕开），只能选一个入口继续。
 * 这是首次访客的首屏：不依赖 Radix/motion/tailwind-merge，进场动效走 tw-animate-css（尊重 reduced-motion）。
 * onIdle：页面 load 后空闲时回调，用于预热应用外壳分包。
 */
export function Onboarding({ onIdle }: { onIdle?: () => void }) {
  useEffect(() => {
    if (!onIdle) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(onIdle, 1500)
    }
    if (document.readyState === "complete") schedule()
    else window.addEventListener("load", schedule, { once: true })
    return () => {
      window.removeEventListener("load", schedule)
      window.clearTimeout(timer)
    }
  }, [onIdle])

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
    <main
      id="main-content"
      aria-labelledby="onboarding-title"
      className="flex min-h-dvh items-start justify-center bg-background px-3 py-4 sm:items-center sm:p-6"
    >
      <div
        data-testid="onboarding"
        className="w-full max-w-md overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-lg animate-in fade-in-0 zoom-in-95 duration-200"
      >
        <div className="relative overflow-hidden px-6 pt-6 pb-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-20 size-48 rounded-full bg-primary/15 blur-3xl"
          />
          <div className="relative flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[color-mix(in_oklch,var(--color-primary)_70%,var(--color-chart-2))] text-sm font-bold text-primary-foreground shadow-sm"
            >
              碎
            </span>
            <h1 id="onboarding-title" className="text-display text-lg">
              欢迎来到碎念
            </h1>
          </div>
          {/* R182 P2-3：首屏收敛为一句话主张，移动端不再被长段落撑出可视区 */}
          <p className="relative mt-3 text-[15px] font-medium">什么都能丢，AI 帮你想起来。</p>
          <p className="relative mt-1 text-xs text-muted-foreground">
            想法、链接、语音、账目随手丢进来，自动分拣打标签、串成思考线索，随时问随时找回。
          </p>
          <p className="relative mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="safety-promise-short">
            {SAFETY_PROMISE_SHORT}当前为小范围 beta，完整承诺见注册页，已知问题见{" "}
            <a href={KNOWN_ISSUES_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
              已知问题清单
            </a>
            。
          </p>
        </div>

        <div className="space-y-4 px-6 pb-6">
          {/* R230 P3-5：场景化示例让陌生用户 5 秒内建立「这是什么、对我有什么用」认知 */}
          <ul className="divide-y rounded-xl border bg-muted/40 text-xs">
            {EXAMPLES.map((ex) => (
              <li key={ex.input} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 truncate text-muted-foreground">「{ex.input}」</span>
                <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
                <span className="shrink-0 font-medium text-foreground">{ex.output}</span>
              </li>
            ))}
          </ul>

          <div className="space-y-2">
            {CHOICES.map((c, i) => {
              const Icon = c.icon
              return (
                <button
                  key={c.action}
                  type="button"
                  onClick={() => choose(c.action)}
                  style={{ animationDelay: `${50 + i * 50}ms` }}
                  className={
                    c.primary
                      ? "group flex w-full items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards duration-200"
                      : "group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-backwards duration-200"
                  }
                >
                  <span
                    className={
                      c.primary
                        ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
                        : "flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground"
                    }
                  >
                    <Icon className="size-4.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{c.title}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{c.description}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </button>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() => choose("import")}
            className="group flex w-full items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-left transition-colors hover:bg-warning/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background outline-none"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
              <PackageOpen className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Cubox / flomo 搬家？三步搬完</span>
              <span className="block text-xs leading-relaxed text-muted-foreground">
                Cubox 速记 2027-05 停服（还剩约 {monthsUntilCuboxShutdown()} 个月）。导出文件 → 设置页一键导入 → 原时间与标签全保留，AI 自动补分拣、串线索
              </span>
            </span>
            <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>

          {/* 多端入口展示属于锦上添花，小屏隐藏以保证三个主入口首屏可见 */}
          <div className="hidden sm:block">
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
                    className="rounded-lg border p-2 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none"
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

          <p className="text-center text-[11px] text-muted-foreground">
            开源可自部署 · 数据在你自己的 Cloudflare 账号里 ·{" "}
            <a href={REPO} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
              GitHub
            </a>
          </p>
        </div>
      </div>
    </main>
  )
}
