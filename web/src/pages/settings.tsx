import { useState } from "react"
import { Check } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { loadSettings, saveSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

export function SettingsPage() {
  const [settings, setSettings] = useState(loadSettings())
  const [saved, setSaved] = useState(false)

  function save() {
    saveSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-medium">数据源</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            后端未就绪时可使用 Mock 数据体验完整功能
          </p>
          <div className="mt-2 flex gap-1 rounded-lg bg-secondary p-1">
            {(
              [
                { value: true, label: "Mock 数据" },
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

        <Button onClick={save} className="w-full sm:w-auto">
          {saved ? (
            <>
              <Check /> 已保存
            </>
          ) : (
            "保存设置"
          )}
        </Button>
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
