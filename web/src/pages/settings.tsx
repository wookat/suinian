import { useState } from "react"
import { Check, Loader2, CircleCheck, CircleAlert } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { testConnection, type TestConnectionResult } from "@/lib/api"
import { loadSettings, saveSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

export function SettingsPage() {
  const [settings, setSettings] = useState(loadSettings())
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  function save() {
    saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleTest() {
    if (testing) return
    saveSettings(settings)
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testConnection())
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-medium">数据源</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            演示模式使用本地示例数据，无需后端即可体验完整功能
          </p>
          <div className="mt-2 flex gap-1 rounded-lg bg-secondary p-1">
            {(
              [
                { value: true, label: "演示模式" },
                { value: false, label: "真实 API" },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.value)}
                onClick={() => setSettings((s) => ({ ...s, useMock: opt.value }))}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  settings.useMock === opt.value
                    ? "bg-card shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="api-base" className="text-sm font-medium">
            API Base URL
          </label>
          <Input
            id="api-base"
            type="url"
            placeholder="https://suinian-api.example.workers.dev"
            value={settings.apiBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="api-token" className="text-sm font-medium">
            API Token
          </label>
          <Input
            id="api-token"
            type="password"
            placeholder="Bearer token"
            value={settings.apiToken}
            onChange={(e) => setSettings((s) => ({ ...s, apiToken: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">仅保存在本机浏览器 localStorage</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button onClick={save} className="w-full sm:w-auto">
            {saved ? (
              <>
                <Check /> 已保存
              </>
            ) : (
              "保存设置"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleTest()}
            disabled={testing}
            className="w-full sm:w-auto"
          >
            {testing ? (
              <>
                <Loader2 className="animate-spin" /> 测试中…
              </>
            ) : (
              "测试连接"
            )}
          </Button>
        </div>
        {testResult && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              testResult.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {testResult.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            {testResult.message}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-medium">关于</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          碎念 Suinian — 什么都能丢的 AI 收件箱。往微信 / Android / Web
          随手一丢，AI 帮你分拣、串线索、随时找到。
        </p>
      </Card>
    </div>
  )
}
