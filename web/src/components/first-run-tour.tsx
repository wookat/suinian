import { useEffect, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { PenLine, Sparkles, MessageCircleQuestion, Share2, BellRing, Loader2, Check, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { isWechatConfigured } from "@/lib/api"
import { detectPushSupport, enablePush } from "@/lib/push"
import { loadSettings, saveSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

const STEPS = [
  {
    icon: PenLine,
    // R181 F-5：引导第一步不再命令用户去操作被遮罩挡住的速记框，
    // 改为价值介绍并明示「跳过即可直接开始」
    title: "想到什么，随手丢",
    description:
      "想法、待办、链接、账目……都能打进速记框，回车就存。不用想放哪儿、也不用打标签。看完这几步（或点左下「跳过」）就可以开始丢。",
  },
  {
    icon: Sparkles,
    title: "AI 自动分拣",
    description: "每一条都会被自动分类（想法 / 待办 / 收藏 / 资料）并打上标签；同一个话题的碎片还会自动串成「思考线索」。",
  },
  {
    icon: MessageCircleQuestion,
    title: "问一句就找回",
    description: "速记框里以「?」开头提问，或点右上「问答」按钮——AI 直接从你的笔记里找答案并给出出处。",
  },
  {
    icon: Share2,
    title: "哪里都能丢进来",
    description: "", // 按微信通道实际开通状态动态生成，见 channelStepDescription
  },
  {
    icon: BellRing,
    title: "每天回来看一眼",
    description:
      "开启浏览器通知后，每天早上推送「昨日回顾」帮你温习记过的碎片，待办到点也会提醒你——不开的话这些只能靠自己想起来再看。",
  },
] as const

/** 第四步入口介绍：微信文案与设置页同一开关判定，未开通时不承诺已上线 */
function channelStepDescription(wechatOn: boolean): string {
  return wechatOn
    ? "微信 bot 发消息、浏览器剪藏扩展、Android 分享面板、Claude/Cursor（MCP）都能直达这里，入口见设置页与 GitHub 仓库首页。"
    : "浏览器剪藏扩展、Android 分享面板、Claude/Cursor（MCP）都能直达这里；微信入口即将上线（自部署可用 bridge）。入口见设置页与 GitHub 仓库首页。"
}

const NOTIFY_STEP = STEPS.length - 1

/**
 * One-time 5-step feature tour for freshly registered users entering the
 * timeline for the first time. Skippable; never shown again once dismissed.
 * The last step offers to enable browser push (daily review / todo reminders)
 * right inside the tour — Day2 触达的引导入口（R120 设计项）.
 */
export function FirstRunTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState(1)
  const [wechatOn, setWechatOn] = useState(false)
  const [pushState, setPushState] = useState<"idle" | "working" | "on" | "error">("idle")
  const [pushError, setPushError] = useState("")
  const pushSupport = detectPushSupport()

  useEffect(() => {
    let cancelled = false
    void isWechatConfigured().then((on) => {
      if (!cancelled) setWechatOn(on)
    })
    return () => {
      cancelled = true
    }
  }, [])

  function finish() {
    saveSettings({ ...loadSettings(), tourSeen: true })
    onDone()
  }

  function goTo(next: number) {
    setDirection(next > step ? 1 : -1)
    setStep(next)
  }

  async function turnOnPush() {
    setPushState("working")
    setPushError("")
    try {
      await enablePush()
      setPushState("on")
    } catch (e) {
      setPushState("error")
      setPushError(e instanceof Error ? e.message : "开启失败，可稍后到设置页重试")
    }
  }

  const current = STEPS[step]
  const Icon = current.icon
  const last = step === STEPS.length - 1

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="max-w-sm gap-0 overflow-hidden p-0"
      >
        <div className="px-6 pt-5">
          <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-[color-mix(in_oklch,var(--color-primary)_70%,var(--color-chart-2))] text-xs font-bold text-primary-foreground"
              >
                碎
              </span>
              功能引导
            </span>
            <span className="tabular-nums">
              {step + 1} / {STEPS.length}
            </span>
          </div>
          <Progress
            className="mt-3 h-1"
            aria-label="引导进度"
            value={Math.round(((step + 1) / STEPS.length) * 100)}
          />
        </div>

        <div className="relative min-h-[15.5rem] overflow-hidden px-6 pt-6 pb-2">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <m.div
              key={step}
              custom={direction}
              initial={{ opacity: 0, x: direction * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -24 }}
              transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
              className="flex flex-col items-center gap-3 text-center"
            >
              <span className="flex size-14 items-center justify-center rounded-2xl bg-accent shadow-xs">
                <Icon className="size-7 text-accent-foreground" />
              </span>
              <DialogTitle className="text-display text-base font-semibold sm:text-lg">{current.title}</DialogTitle>
              <DialogDescription className="min-h-20 text-sm leading-relaxed">
                {step === 3 ? channelStepDescription(wechatOn) : current.description}
              </DialogDescription>
              {step === NOTIFY_STEP && (
                <div className="flex w-full flex-col items-center gap-2">
                  {pushSupport === "ok" && pushState !== "on" && (
                    <Button size="sm" variant="outline" onClick={() => void turnOnPush()} disabled={pushState === "working"}>
                      {pushState === "working" ? <Loader2 className="size-4 animate-spin" /> : <BellRing className="size-4" />}
                      开启每日回顾推送
                    </Button>
                  )}
                  {pushState === "on" && (
                    <p role="status" className="inline-flex items-center gap-1 text-sm font-medium text-success">
                      <Check className="size-4" />
                      已开启，每天早上见
                    </p>
                  )}
                  {pushState === "error" && (
                    <p role="alert" className="text-xs text-destructive">
                      {pushError}
                    </p>
                  )}
                  {pushSupport === "ios-needs-install" && (
                    <p className="text-xs text-muted-foreground">iOS 需先「添加到主屏幕」安装为 App 后才能开启通知，之后可到设置页开启。</p>
                  )}
                  {pushSupport === "unsupported" && (
                    <p className="text-xs text-muted-foreground">当前浏览器不支持通知，可换 Chrome/Edge 后到设置页开启。</p>
                  )}
                </div>
              )}
            </m.div>
          </AnimatePresence>
        </div>

        <div className="flex justify-center gap-1.5 px-6 pb-2">
          {STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`第 ${i + 1} 步`}
              aria-current={i === step ? "step" : undefined}
              onClick={() => goTo(i)}
              className="flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "block h-1.5 rounded-full transition-all duration-300",
                  i === step ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30",
                )}
              />
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t bg-muted/30 px-6 py-3">
          <Button variant="ghost" size="sm" onClick={finish} className="text-muted-foreground">
            跳过
          </Button>
          <Button size="sm" onClick={() => (last ? finish() : goTo(step + 1))}>
            {last ? "开始使用" : "下一步"}
            {!last && <ArrowRight />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
