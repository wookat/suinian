import { useState } from "react"
import { Loader2, CircleAlert, UserPlus, LogIn, Download, Trash2, KeyRound, Copy, Check } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { createNote, login, recoverAccount, register } from "@/lib/api"
import { clearDemoNotes, userDemoNotes } from "@/lib/mock"
import { defaultApiBase, loadSettings, saveSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { Note } from "@/lib/types"

type Mode = "register" | "login" | "recover"

/**
 * 一次性恢复码展示（R144 P1-2）：服务端只存哈希，明文仅此处出现一次，
 * 必须让用户主动确认已保存后才继续。
 */
export function RecoveryCodeCard({ code, onDone }: { code: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Card className="space-y-4 p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <KeyRound className="size-4" /> 请保存你的恢复码
      </h2>
      <p className="text-sm text-muted-foreground">
        忘记密码时，这个恢复码是找回账号的唯一方式（产品不收集邮箱/手机号）。
        它只显示这一次，服务端不保存明文，丢失后无法找回——请抄下来或存进密码管理器。
      </p>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-sm font-semibold tracking-wide">
          {code}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
          aria-label="复制恢复码"
          title="复制恢复码"
          className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>
      <Button onClick={onDone} className="w-full">
        我已安全保存，继续
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
      <Card className="space-y-4 p-4">
        <h2 className="text-base font-semibold">演示模式里还有 {notes.length} 条你记的笔记</h2>
        <p className="text-sm text-muted-foreground">
          这些笔记目前只存在本机浏览器里，不会自动同步到账号。可以一键导入新账号（AI 会重新分拣），或直接清理。
        </p>
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md bg-secondary/50 p-2 text-xs text-muted-foreground">
          {notes.map((n) => (
            <li key={n.id} className="truncate">
              {n.content}
            </li>
          ))}
        </ul>
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            导入失败（已导入 {progress}/{notes.length}）：{error}
          </p>
        )}
        <div className="flex gap-2">
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
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [demoNotes, setDemoNotes] = useState<Note[] | null>(null)
  const [recoveryInput, setRecoveryInput] = useState("")
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)
  // 注册/找回成功但服务端恢复码生成失败（降级返回 null）：需明确告知去设置页补生成
  const [recoveryMissing, setRecoveryMissing] = useState(false)

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
    setSlow(false)
    const base = apiBaseUrl.trim()
    if (!base) return setError("请填写 API 地址")
    if (name.trim().length < 2) return setError("用户名至少 2 个字符")
    if (mode === "recover" && recoveryInput.trim().length < 16) return setError("请填写注册时保存的恢复码")
    if (password.length < 8) return setError(mode === "recover" ? "新密码至少 8 个字符" : "密码至少 8 个字符")
    if (mode !== "login" && password !== password2) {
      // 只用确认框下的内联提示，不另发全局 error，避免同屏重复与修正后残留旧错误
      setMismatch(true)
      return
    }
    setBusy(true)
    const slowTimer = window.setTimeout(() => setSlow(true), 4000)
    try {
      const res =
        mode === "register"
          ? await register(base, name.trim(), password)
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
        tourSeen: mode !== "register",
      })
      if (res.recovery_code) {
        // 注册/找回成功：先展示一次性恢复码，用户确认保存后再进入应用
        setRecoveryCode(res.recovery_code)
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
      setSlow(false)
      setBusy(false)
    }
  }

  if (recoveryMissing)
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <Card className="space-y-4 p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CircleAlert className="size-4 text-destructive" /> 恢复码未能生成
          </h2>
          <p className="text-sm text-muted-foreground">
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
          onDone={() => {
            setRecoveryCode(null)
            continueAfterAuth()
          }}
        />
      </div>
    )

  if (demoNotes) return <DemoMigratePrompt notes={demoNotes} />

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <Card className="space-y-4 p-4">
        <div className="flex gap-1 rounded-lg bg-secondary p-1">
          {(
            [
              { value: "register", label: "注册新账号", icon: UserPlus },
              { value: "login", label: "登录", icon: LogIn },
              { value: "recover", label: "找回", icon: KeyRound },
            ] as const
          ).map((opt) => {
            const Icon = opt.icon
            return (
              <button
                key={opt.value}
                onClick={() => {
                  setMode(opt.value)
                  setError(null)
                  setMismatch(false)
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors sm:px-3",
                  mode === opt.value
                    ? "bg-card shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{opt.label}</span>
              </button>
            )
          })}
        </div>

        {showApiBase ? (
          <div className="space-y-1.5">
            <label htmlFor="auth-base" className="text-sm font-medium">
              API 地址
            </label>
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
            onClick={() => setShowApiBase(true)}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            高级：修改 API 地址（自部署用，当前：{apiBaseUrl}）
          </button>
        )}

        <div className="space-y-1.5">
          <label htmlFor="auth-name" className="text-sm font-medium">
            用户名
          </label>
          <Input
            id="auth-name"
            type="text"
            autoComplete="username"
            placeholder="2-32 个字符（中英文、数字、._-[]）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {mode === "recover" && (
          <div className="space-y-1.5">
            <label htmlFor="auth-recovery" className="text-sm font-medium">
              恢复码
            </label>
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
          <label htmlFor="auth-password" className="text-sm font-medium">
            {mode === "recover" ? "新密码" : "密码"}
          </label>
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
            <label htmlFor="auth-password2" className="text-sm font-medium">
              {mode === "recover" ? "确认新密码" : "确认密码"}
            </label>
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
              <p className="flex items-center gap-1 text-xs text-destructive">
                <CircleAlert className="size-3.5 shrink-0" />
                两次输入的密码不一致，请重新输入
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert className="size-4 shrink-0" />
            {error}
          </p>
        )}

        {busy && slow && (
          <p className="text-xs text-muted-foreground">
            {mode === "register" ? "正在创建账号（密码加密需几秒），请保持页面打开…" : "正在验证，请稍候…"}
          </p>
        )}

        <Button onClick={() => void submit()} disabled={busy} className="w-full">
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

        <p className="text-xs leading-relaxed text-muted-foreground">
          {mode === "register"
            ? "注册成功后会获得一次性恢复码（忘记密码时的唯一找回方式，请务必保存），并自动获得 API token 写入本机配置，可在设置页查看/复制/轮换。"
            : mode === "recover"
              ? "验证通过后会重置密码并直接登录；旧 token 同时作废，其他设备需重新登录。"
              : "登录成功后会取回你的 API token 并写入本机配置。老账号如未设置过密码，请在设置页直接填 token。"}
        </p>
      </Card>
    </div>
  )
}
