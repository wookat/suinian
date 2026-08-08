import { useState } from "react"
import { Loader2, CircleAlert, UserPlus, LogIn } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { login, register } from "@/lib/api"
import { defaultApiBase, loadSettings, saveSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

type Mode = "register" | "login"

export function AuthPage() {
  const [mode, setMode] = useState<Mode>(() =>
    window.location.hash.includes("mode=login") ? "login" : "register",
  )
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBase)
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [password2, setPassword2] = useState("")
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (busy) return
    setError(null)
    setSlow(false)
    const base = apiBaseUrl.trim()
    if (!base) return setError("请填写 API 地址")
    if (name.trim().length < 2) return setError("用户名至少 2 个字符")
    if (password.length < 8) return setError("密码至少 8 个字符")
    if (mode === "register" && password !== password2) return setError("两次输入的密码不一致")
    setBusy(true)
    const slowTimer = window.setTimeout(() => setSlow(true), 4000)
    try {
      const res =
        mode === "register"
          ? await register(base, name.trim(), password)
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
      window.location.hash = "#/"
    } catch (e) {
      const msg = e instanceof Error ? e.message : "请求失败，请稍后重试"
      setError(mode === "register" ? `${msg}。可直接用相同用户名密码重试，不会重复创建账号。` : msg)
    } finally {
      window.clearTimeout(slowTimer)
      setSlow(false)
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <Card className="space-y-4 p-4">
        <div className="flex gap-1 rounded-lg bg-secondary p-1">
          {(
            [
              { value: "register", label: "注册新账号", icon: UserPlus },
              { value: "login", label: "登录", icon: LogIn },
            ] as const
          ).map((opt) => {
            const Icon = opt.icon
            return (
              <button
                key={opt.value}
                onClick={() => {
                  setMode(opt.value)
                  setError(null)
                }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === opt.value
                    ? "bg-card shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {opt.label}
              </button>
            )
          })}
        </div>

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

        <div className="space-y-1.5">
          <label htmlFor="auth-password" className="text-sm font-medium">
            密码
          </label>
          <Input
            id="auth-password"
            type="password"
            autoComplete={mode === "register" ? "new-password" : "current-password"}
            placeholder="至少 8 个字符"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && mode === "login") void submit()
            }}
          />
        </div>

        {mode === "register" && (
          <div className="space-y-1.5">
            <label htmlFor="auth-password2" className="text-sm font-medium">
              确认密码
            </label>
            <Input
              id="auth-password2"
              type="password"
              autoComplete="new-password"
              placeholder="再输入一次"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit()
              }}
            />
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
          ) : (
            "登录"
          )}
        </Button>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {mode === "register"
            ? "注册成功后会自动获得 API token 并写入本机配置，可在设置页查看/复制/轮换。"
            : "登录成功后会取回你的 API token 并写入本机配置。老账号如未设置过密码，请在设置页直接填 token。"}
        </p>
      </Card>
    </div>
  )
}
