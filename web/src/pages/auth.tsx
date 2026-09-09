import { useEffect, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { Loader2, CircleAlert, UserPlus, LogIn, Download, Trash2, KeyRound, Copy, Check, Ticket, ShieldCheck } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Segmented } from "@/components/ui/segmented"
import { Progress } from "@/components/ui/progress"
import { createNote, fetchRegisterPolicy, login, recoverAccount, register, type RegisterPolicy } from "@/lib/api"
import { clearDemoNotes, userDemoNotes } from "@/lib/mock"
import { defaultApiBase, loadSettings, saveSettings } from "@/lib/settings"
import { cn, KNOWN_ISSUES_URL } from "@/lib/utils"
import { SafetyPromise } from "@/components/safety-promise"
import type { Note } from "@/lib/types"

type Mode = "register" | "login" | "recover"

const MODE_OPTIONS: { value: Mode; label: string; icon: typeof UserPlus }[] = [
  { value: "register", label: "注册新账号", icon: UserPlus },
  { value: "login", label: "登录", icon: LogIn },
  { value: "recover", label: "找回", icon: KeyRound },
]

const MODE_COPY: Record<Mode, { title: string; blurb: string }> = {
  register: { title: "开始用碎念", blurb: "无需邮箱 / 手机号，一个用户名加密码就能开始记录" },
  login: { title: "欢迎回来", blurb: "登录后会取回你的 API token 并写入本机配置" },
  recover: { title: "用恢复码找回账号", blurb: "验证通过后会重置密码并直接登录" },
}

/**
 * 一次性恢复码展示（R144 P1-2）：服务端只存哈希，明文仅此处出现一次，
 * 必须让用户主动确认已保存后才继续。
 */
export function RecoveryCodeCard({
  code,
  onDone,
  tokensRotated = false,
}: {
  code: string
  onDone: () => void
  /** 找回/重置场景：旧 token 已全部作废，需提醒重配集成（audit-r191 D-2） */
  tokensRotated?: boolean
}) {
  const [copied, setCopied] = useState(false)
  // R182 P2-4：恢复码是唯一找回途径，「我已安全保存」需要一次弱确认——
  // 点过复制，或手动输入末 4 位，二者其一才放行
  const [confirmed, setConfirmed] = useState(false)
  const [verifyInput, setVerifyInput] = useState("")
  const last4 = code.replace(/[^0-9a-zA-Z]/g, "").slice(-4)
  const verified = confirmed || verifyInput.trim().toLowerCase() === last4.toLowerCase()
  return (
    <Card className="space-y-4 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-display text-base font-semibold sm:text-lg">
            {tokensRotated ? "请保存你的新恢复码" : "账号已就绪，最后一步：存好恢复码"}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            碎念不收集邮箱/手机号，隐私更安心——代价是忘记密码时，这个恢复码是找回账号的唯一方式。
            它只显示这一次（服务端不存明文），点一下复制存进密码管理器或备忘录，十秒就好；密码和恢复码都丢失时账号将无法找回。
          </p>
        </div>
      </div>
      {tokensRotated && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm leading-relaxed text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          找回已重置全部登录凭证：其他设备、浏览器扩展、MCP/API 集成的旧 token 已全部失效，需重新登录或到设置页复制新 token 重新配置。
        </p>
      )}
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-3.5">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-[15px] font-semibold tracking-wider">
          {code}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true)
                setConfirmed(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
          aria-label="复制恢复码"
          title="复制恢复码"
          className="shrink-0"
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
      {!verified && (
        <div className="space-y-1">
          <Input
            value={verifyInput}
            onChange={(e) => setVerifyInput(e.target.value)}
            placeholder={`点上方复制，或输入恢复码末 4 位确认已保存`}
            aria-label="输入恢复码末 4 位确认已保存"
            maxLength={8}
          />
        </div>
      )}
      <Button onClick={onDone} disabled={!verified} size="lg" className="w-full">
        <ShieldCheck /> 已存好，开始记录
      </Button>
    </Card>
  )
}

/**
 * 登录/注册成功后的演示数据处置（D-2/D-3）：有用户自己记的演示笔记则
 * 提示导入或清理，不再静默滞留 localStorage 明文。
 */
function DemoMigratePrompt({ notes }: { notes: Note[] }) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)

  function done() {
    clearDemoNotes()
    window.location.hash = "#/"
  }

  async function importAll() {
    setBusy(true)
    setError(null)
    try {
      for (const [i, n] of notes.entries()) {
        await createNote({
          source: "import",
          raw_type: "text",
          content: n.content,
          url: n.url ?? undefined,
          tags: n.tags.length > 0 ? n.tags : undefined,
        })
        setProgress(i + 1)
      }
      done()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <Card className="space-y-4 p-5 sm:p-6">
        <div>
          <h2 className="text-display text-base font-semibold sm:text-lg">
            演示模式里还有 {notes.length} 条你记的笔记
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            这些笔记目前只存在本机浏览器里，不会自动同步到账号。可以一键导入新账号（AI 会重新分拣），或直接清理。
          </p>
        </div>
        <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border bg-muted/40 text-xs text-muted-foreground">
          {notes.map((n) => (
            <li key={n.id} className="truncate px-3 py-1.5">
              {n.content}
            </li>
          ))}
        </ul>
        {busy && <Progress className="h-1.5" aria-label="导入进度" value={Math.round((progress / notes.length) * 100)} />}
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            导入失败（已导入 {progress}/{notes.length}）：{error}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => void importAll()} disabled={busy} className="flex-1">
            {busy ? (
              <>
                <Loader2 className="animate-spin" /> 导入中 {progress}/{notes.length}
              </>
            ) : (
              <>
                <Download /> 导入到账号
              </>
            )}
          </Button>
          <Button variant="outline" onClick={done} disabled={busy} className="flex-1">
            <Trash2 /> 清理演示数据
          </Button>
        </div>
      </Card>
    </div>
  )
}

export function AuthPage() {
  const [mode, setMode] = useState<Mode>(() =>
    window.location.hash.includes("mode=login") ? "login" : "register",
  )
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBase)
  // 默认折叠 API 地址（自部署才需要改）；推不出默认值时必须展开让用户填
  const [showApiBase, setShowApiBase] = useState(() => !defaultApiBase())
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [password2, setPassword2] = useState("")
  const [busy, setBusy] = useState(false)
  // 慢请求分阶段提示：0=正常，1=超 4s（服务端加密/冷启动），2=超 16s（首次
  // 尝试已超时，客户端正自动换新连接重试），给出预期时长而非无限 spinner
  const [slowStage, setSlowStage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [demoNotes, setDemoNotes] = useState<Note[] | null>(null)
  const [recoveryInput, setRecoveryInput] = useState("")
  const [inviteCode, setInviteCode] = useState("")
  // beta 注册策略（R318 D）：null = 尚未取到/取不到，按开放注册渲染，服务端仍会拒绝无码注册
  const [policy, setPolicy] = useState<RegisterPolicy | null>(null)
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)
  // 注册/找回成功但服务端恢复码生成失败（降级返回 null）：需明确告知去设置页补生成
  const [recoveryMissing, setRecoveryMissing] = useState(false)

  useEffect(() => {
    const base = apiBaseUrl.trim()
    if (!base) return
    let cancelled = false
    void fetchRegisterPolicy(base).then((p) => {
      if (!cancelled) setPolicy(p)
    })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl])

  const inviteRequired = policy?.invite_required === true
  const registerBlocked = policy !== null && (!policy.enabled || policy.quota_full)

  function continueAfterAuth() {
    const leftover = userDemoNotes()
    if (leftover.length > 0) {
      setDemoNotes(leftover)
    } else {
      // 只剩种子数据副本：静默清理，不打扰（D-3）
      clearDemoNotes()
      window.location.hash = "#/"
    }
  }

  async function submit() {
    if (busy) return
    setError(null)
    setMismatch(false)
    setSlowStage(0)
    const base = apiBaseUrl.trim()
    if (!base) return setError("请填写 API 地址")
    if (name.trim().length < 2) return setError("用户名至少 2 个字符")
    if (mode === "recover" && recoveryInput.trim().length < 16) return setError("请填写注册时保存的恢复码")
    if (mode === "register" && inviteRequired && !inviteCode.trim()) return setError("当前为小范围 beta，注册需要邀请码")
    if (password.length < 8) return setError(mode === "recover" ? "新密码至少 8 个字符" : "密码至少 8 个字符")
    if (mode !== "login" && password !== password2) {
      // 只用确认框下的内联提示，不另发全局 error，避免同屏重复与修正后残留旧错误
      setMismatch(true)
      return
    }
    setBusy(true)
    const slowTimer = window.setTimeout(() => setSlowStage(1), 4000)
    const slowTimer2 = window.setTimeout(() => setSlowStage(2), 16000)
    try {
      const res =
        mode === "register"
          ? await register(base, name.trim(), password, inviteCode)
          : mode === "recover"
            ? await recoverAccount(base, name.trim(), recoveryInput.trim(), password)
            : await login(base, name.trim(), password)
      saveSettings({
        ...loadSettings(),
        apiBaseUrl: base,
        apiToken: res.api_token,
        useMock: false,
        onboarded: true,
        // fresh registrations get the one-time feature tour on first timeline entry
        //（幂等重试命中已有账号时本质是登录，不重放引导）
        tourSeen: mode !== "register" || res.existing === true,
      })
      if (res.recovery_code) {
        // 注册/找回成功：先展示一次性恢复码，用户确认保存后再进入应用
        setRecoveryCode(res.recovery_code)
      } else if (mode === "register" && res.existing) {
        // 同名同密码命中已有账号的幂等重试：本质是登录，恢复码早在首次
        // 注册时发过，不得误报「恢复码未能生成」
        continueAfterAuth()
      } else if (mode !== "login") {
        // 服务端恢复码生成失败会降级返回 null：必须明确告知，否则用户
        // 直到忘密码那天才发现自己没有任何找回途径
        setRecoveryMissing(true)
      } else {
        continueAfterAuth()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "请求失败，请稍后重试"
      setError(mode === "register" ? `${msg}。可直接用相同用户名密码重试，不会重复创建账号。` : msg)
    } finally {
      window.clearTimeout(slowTimer)
      window.clearTimeout(slowTimer2)
      setSlowStage(0)
      setBusy(false)
    }
  }

  if (recoveryMissing)
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <Card className="space-y-4 border-destructive/30 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-destructive-soft text-destructive">
              <CircleAlert className="size-5" />
            </span>
            <h2 className="text-display pt-1.5 text-base font-semibold sm:text-lg">恢复码未能生成</h2>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            操作已成功，但服务端未能生成恢复码。恢复码是忘记密码时找回账号的唯一方式，
            请进入应用后尽快在设置页点「重新生成恢复码」并安全保存。
          </p>
          <Button
            onClick={() => {
              setRecoveryMissing(false)
              continueAfterAuth()
            }}
            className="w-full"
          >
            我知道了，进入应用后去生成
          </Button>
        </Card>
      </div>
    )

  if (recoveryCode)
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <RecoveryCodeCard
          code={recoveryCode}
          tokensRotated={mode === "recover"}
          onDone={() => {
            setRecoveryCode(null)
            continueAfterAuth()
          }}
        />
      </div>
    )

  if (demoNotes) return <DemoMigratePrompt notes={demoNotes} />

  const copy = MODE_COPY[mode]

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <Card className="relative overflow-hidden p-5 sm:p-6">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-24 size-56 rounded-full bg-primary/10 blur-3xl"
        />
        <div className="relative space-y-5">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[color-mix(in_oklch,var(--color-primary)_70%,var(--color-chart-2))] text-base font-bold text-primary-foreground shadow-sm"
            >
              碎
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={mode}
                className="min-w-0"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.16 }}
              >
                <h2 className="text-display text-lg font-semibold">{copy.title}</h2>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{copy.blurb}</p>
              </m.div>
            </AnimatePresence>
          </div>

          <Segmented
            aria-label="登录方式"
            value={mode}
            onValueChange={(v) => {
              setMode(v)
              setError(null)
              setMismatch(false)
            }}
            options={MODE_OPTIONS}
          />

          {showApiBase ? (
            <div className="space-y-1.5">
              <Label htmlFor="auth-base">API 地址</Label>
              <Input
                id="auth-base"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://suinian-api.example.workers.dev"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                官方托管版或你自部署的 worker 地址
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowApiBase(true)}
              className="break-all text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              高级：修改 API 地址（自部署用，当前：{apiBaseUrl}）
            </button>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="auth-name">用户名</Label>
            <Input
              id="auth-name"
              type="text"
              autoComplete="username"
              placeholder="2-32 个字符（中英文、数字、._-[]）"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {mode === "register" && registerBlocked && (
            <p
              role="status"
              className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground"
              data-testid="register-blocked"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {policy?.enabled === false
                ? "注册已关闭；已有账号请切到「登录」。"
                : "小范围 beta 名额已满，暂不接受新注册；已有账号请切到「登录」。"}
            </p>
          )}

          {mode === "register" && inviteRequired && !registerBlocked && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-invite">
                <Ticket className="size-3.5" /> 邀请码
              </Label>
              <Input
                id="auth-invite"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="小范围 beta：填写获得的邀请码"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">当前仅对受邀用户开放注册；已有账号直接登录不需要邀请码。</p>
            </div>
          )}

          {mode === "recover" && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-recovery">恢复码</Label>
              <Input
                id="auth-recovery"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX（注册时保存的）"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                大小写不限，带不带连字符都可以；找回成功后旧恢复码作废，会发一个新的
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="auth-password">{mode === "recover" ? "新密码" : "密码"}</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="至少 8 个字符"
              aria-invalid={mismatch || undefined}
              className={cn(mismatch && "border-destructive focus-visible:ring-destructive/40")}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setMismatch(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && mode === "login") void submit()
              }}
            />
          </div>

          {mode !== "login" && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-password2">{mode === "recover" ? "确认新密码" : "确认密码"}</Label>
              <Input
                id="auth-password2"
                type="password"
                autoComplete="new-password"
                placeholder="再输入一次"
                aria-invalid={mismatch || undefined}
                className={cn(mismatch && "border-destructive focus-visible:ring-destructive/40")}
                value={password2}
                onChange={(e) => {
                  setPassword2(e.target.value)
                  setMismatch(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit()
                }}
              />
              {mismatch && (
                <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
                  <CircleAlert className="size-3.5 shrink-0" />
                  两次输入的密码不一致，请重新输入
                </p>
              )}
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}

          {busy && slowStage === 1 && (
            <p role="status" className="text-xs text-muted-foreground">
              {mode === "register"
                ? "正在创建账号（密码加密与首次启动通常需 3–10 秒），请保持页面打开…"
                : "正在验证（通常 10 秒内完成），请稍候…"}
            </p>
          )}
          {busy && slowStage >= 2 && (
            <p role="status" className="text-xs text-muted-foreground">
              首次尝试未在 15 秒内返回，已自动换新连接重试（最长再等约 45 秒）。
              {mode === "register" ? "重试不会重复创建账号。" : ""}
            </p>
          )}

          <Button
            onClick={() => void submit()}
            disabled={busy || (mode === "register" && registerBlocked)}
            size="lg"
            className="w-full"
          >
            {busy ? (
              <>
                <Loader2 className="animate-spin" /> 提交中…
              </>
            ) : mode === "register" ? (
              "注册并开始使用"
            ) : mode === "recover" ? (
              "重置密码并登录"
            ) : (
              "登录"
            )}
          </Button>

          {mode === "login" && (
            <button
              type="button"
              onClick={() => {
                setMode("recover")
                setError(null)
                setMismatch(false)
              }}
              className="text-xs font-medium text-primary hover:underline"
            >
              忘记密码？用恢复码找回
            </button>
          )}

          <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
            {mode === "register"
              ? "无需邮箱/手机号，注册完即可开始记录。成功后会发一个一次性恢复码（忘记密码时用它找回账号），API token 自动写入本机配置，可在设置页查看/复制/轮换。"
              : mode === "recover"
                ? "验证通过后会重置密码并直接登录；旧 token 同时作废，其他设备需重新登录。"
                : "登录成功后会取回你的 API token 并写入本机配置。老账号如未设置过密码，请在设置页直接填 token。"}
          </p>
        </div>
      </Card>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground" data-testid="safety-promise">
        <SafetyPromise />
      </p>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">
        当前为小范围 beta：已知问题与未覆盖的情形见{" "}
        <a href={KNOWN_ISSUES_URL} target="_blank" rel="noreferrer" className="underline hover:text-foreground" data-testid="known-issues-link">
          已知问题清单
        </a>
        。
      </p>
    </div>
  )
}
