import { useRef, useState } from "react"
import {
  Check,
  Loader2,
  CircleCheck,
  CircleAlert,
  Sun,
  Moon,
  Monitor,
  Copy,
  RefreshCw,
  UserPlus,
  Trash2,
  Download,
  LogOut,
  Upload,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  deleteAccount,
  exportData,
  importData,
  rotateToken,
  testConnection,
  MAX_IMPORT_BYTES,
  type ImportSource,
  type ImportStats,
  type TestConnectionResult,
} from "@/lib/api"
import { loadSettings, saveSettings } from "@/lib/settings"
import { loadTheme, setTheme, type ThemeMode } from "@/lib/theme"
import { cn } from "@/lib/utils"

const IMPORT_SOURCES: { value: ImportSource; label: string; hint: string; accept: string }[] = [
  { value: "cubox", label: "Cubox", hint: "支持 Cubox 导出的 CSV / 书签 HTML / txt 文件", accept: ".csv,.html,.htm,.txt" },
  { value: "flomo", label: "flomo", hint: "支持 flomo 导出压缩包里的 HTML 文件（如 index.html）", accept: ".html,.htm" },
  { value: "markdown", label: "Markdown", hint: "按 --- 分隔线或标题拆条；段落首行为日期时作为原创建时间", accept: ".md,.markdown,.txt" },
  { value: "text", label: "纯文本", hint: "按空行拆条，每段一条笔记", accept: ".txt,.md" },
]

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
]

export function SettingsPage() {
  const [settings, setSettings] = useState(loadSettings())
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [theme, setThemeState] = useState<ThemeMode>(loadTheme)
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [accountMsg, setAccountMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [exporting, setExporting] = useState<"json" | "markdown" | null>(null)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [importSource, setImportSource] = useState<ImportSource>("cubox")
  const [guideOpen, setGuideOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  async function handleImportFile(file: File) {
    if (importing) return
    if (file.size > MAX_IMPORT_BYTES) {
      setImportMsg({ ok: false, text: "文件过大：最大支持 20MB" })
      return
    }
    setImporting(true)
    setImportMsg(null)
    try {
      const stats: ImportStats = await importData(file, importSource)
      setImportMsg({
        ok: true,
        text: `导入完成：共解析 ${stats.total} 条，成功 ${stats.imported} 条，跳过重复 ${stats.skipped} 条${stats.failed > 0 ? `，失败 ${stats.failed} 条` : ""}。AI 分拣/线索/图谱会在后台陆续完成`,
      })
    } catch (e) {
      setImportMsg({ ok: false, text: e instanceof Error ? e.message : "导入失败，请稍后重试" })
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ""
    }
  }

  async function handleExport(format: "json" | "markdown") {
    if (exporting) return
    setExporting(format)
    setExportMsg(null)
    try {
      const { blob, filename } = await exportData(format, includeSensitive)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setExportMsg({ ok: true, text: `已导出 ${filename}${includeSensitive ? "（含敏感内容明文）" : "（敏感内容已脱敏）"}` })
    } catch (e) {
      setExportMsg({ ok: false, text: e instanceof Error ? e.message : "导出失败，请稍后重试" })
    } finally {
      setExporting(null)
    }
  }

  async function copyToken() {
    const token = loadSettings().apiToken
    if (!token) {
      setAccountMsg({ ok: false, text: "当前未配置 token" })
      return
    }
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setAccountMsg({ ok: false, text: "复制失败，请手动从上方输入框复制" })
    }
  }

  async function handleRotate() {
    if (rotating) return
    if (!window.confirm("轮换后旧 token 立即失效，其它设备（微信桥 / Android）需同步更新。确定轮换？")) return
    setRotating(true)
    setAccountMsg(null)
    try {
      const token = await rotateToken()
      const next = { ...loadSettings(), apiToken: token }
      setSettings(next)
      saveSettings(next)
      setAccountMsg({ ok: true, text: "已轮换并保存新 token，请同步更新其它设备" })
    } catch (e) {
      setAccountMsg({ ok: false, text: e instanceof Error ? e.message : "轮换失败，请稍后重试" })
    } finally {
      setRotating(false)
    }
  }

  function handleLogout() {
    if (
      !window.confirm(
        "退出登录只会清除本机保存的 token 与设置，云端笔记/线索/周报全部保留，重新登录即可找回。确定退出？",
      )
    )
      return
    saveSettings({ apiBaseUrl: "", apiToken: "", useMock: true, onboarded: false })
    window.location.hash = "#/"
    window.location.reload()
  }

  async function handleDeleteAccount() {
    if (deleting) return
    if (!window.confirm("注销将永久删除账号及全部笔记/线索/周报，无法恢复。确定继续？")) return
    const typed = window.prompt('最后确认：请输入「注销」两个字以永久删除账号和全部数据')
    if (typed !== "注销") {
      if (typed !== null) setAccountMsg({ ok: false, text: "输入不匹配，已取消注销" })
      return
    }
    setDeleting(true)
    setAccountMsg(null)
    try {
      await deleteAccount()
      saveSettings({ apiBaseUrl: "", apiToken: "", useMock: true, onboarded: false })
      window.location.hash = "#/"
      window.location.reload()
    } catch (e) {
      setAccountMsg({ ok: false, text: e instanceof Error ? e.message : "注销失败，请稍后重试" })
      setDeleting(false)
    }
  }

  function save() {
    const next =
      settings.useMock && settings.apiBaseUrl.trim() && settings.apiToken.trim()
        ? { ...settings, useMock: false }
        : settings
    setSettings(next)
    saveSettings(next)
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
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
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

      <Card className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-medium">账号</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            还没有账号？支持用户名 + 密码自助注册，注册后自动配置 token
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button variant="outline" onClick={() => (window.location.hash = "#/auth")} className="w-full sm:w-auto">
            <UserPlus /> 注册 / 登录
          </Button>
          <Button variant="outline" onClick={() => void copyToken()} className="w-full sm:w-auto">
            {copied ? (
              <>
                <Check /> 已复制
              </>
            ) : (
              <>
                <Copy /> 复制我的 API token
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleRotate()}
            disabled={rotating}
            className="w-full sm:w-auto"
          >
            {rotating ? (
              <>
                <Loader2 className="animate-spin" /> 轮换中…
              </>
            ) : (
              <>
                <RefreshCw /> 轮换 token
              </>
            )}
          </Button>
          <Button variant="outline" onClick={handleLogout} className="w-full sm:w-auto">
            <LogOut /> 退出登录
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          退出登录仅清除本机登录状态，云端数据不受影响，重新登录即可找回全部笔记
        </p>
        {accountMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              accountMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {accountMsg.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            {accountMsg.text}
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-medium">导出数据</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            导出全部笔记/线索/周报。敏感笔记默认脱敏，勾选后才会明文导出
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={includeSensitive}
            onCheckedChange={(v) => setIncludeSensitive(v === true)}
          />
          包含敏感内容（明文导出密码等加密笔记）
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            onClick={() => void handleExport("json")}
            disabled={exporting !== null}
            className="w-full sm:w-auto"
          >
            {exporting === "json" ? (
              <>
                <Loader2 className="animate-spin" /> 导出中…
              </>
            ) : (
              <>
                <Download /> 导出 JSON
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleExport("markdown")}
            disabled={exporting !== null}
            className="w-full sm:w-auto"
          >
            {exporting === "markdown" ? (
              <>
                <Loader2 className="animate-spin" /> 导出中…
              </>
            ) : (
              <>
                <Download /> 导出 Markdown
              </>
            )}
          </Button>
        </div>
        {exportMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              exportMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {exportMsg.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            {exportMsg.text}
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-medium">导入数据</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            从 Cubox / flomo / Markdown / 纯文本导出文件批量导入笔记，保留原创建时间与标签，重复内容自动跳过（单文件最大 20MB）
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-secondary p-1">
          {IMPORT_SOURCES.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setImportSource(opt.value)}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                importSource === opt.value
                  ? "bg-card shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {IMPORT_SOURCES.find((o) => o.value === importSource)?.hint}
        </p>
        <input
          ref={importInputRef}
          type="file"
          accept={IMPORT_SOURCES.find((o) => o.value === importSource)?.accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleImportFile(f)
          }}
        />
        <p className="text-xs text-muted-foreground">
          正在从 Cubox / flomo 搬家？
          <button
            onClick={() => setGuideOpen((v) => !v)}
            className="ml-1 font-medium text-primary underline underline-offset-2"
          >
            查看迁移指南
          </button>
          ，三步完成导出、导入与验收。
        </p>
        {guideOpen && (
          <div className="space-y-2 rounded-lg border bg-secondary/40 p-3 text-xs leading-relaxed">
            <p className="font-medium">三步完成迁移（原创建时间与标签全部保留）：</p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>
                <span className="font-medium">导出</span>：Cubox 在「共享/导出」选 CSV（推荐，书签 HTML / txt 也支持）；flomo
                在「设置 → 账号详情 → 导出所有数据（HTML）」，解压后取其中的 HTML 文件；其他工具导出 Markdown / 纯文本也可。
              </li>
              <li>
                <span className="font-medium">导入</span>：在上方选择对应来源 →「选择文件导入」，完成后显示导入统计；重复导入同一文件会自动跳过已有条目，放心多试。
              </li>
              <li>
                <span className="font-medium">验收</span>：回首页时间流按原时间抽查几条历史笔记；AI
                分拣、线索聚类会在后台陆续完成；之后每天首页的「今日回顾」还会把老笔记重新翻出来。
              </li>
            </ol>
            <p className="text-muted-foreground">
              提示：flomo 压缩包里的图片暂不导入（正文文字全部保留）；来源选错时会提示「未能解析出笔记」，不会写入脏数据。
            </p>
          </div>
        )}
        <Button
          variant="outline"
          onClick={() => importInputRef.current?.click()}
          disabled={importing}
          className="w-full sm:w-auto"
        >
          {importing ? (
            <>
              <Loader2 className="animate-spin" /> 导入中，请勿关闭页面…
            </>
          ) : (
            <>
              <Upload /> 选择文件导入
            </>
          )}
        </Button>
        {importMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              importMsg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {importMsg.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            {importMsg.text}
          </p>
        )}
      </Card>

      <Card className="space-y-3 border-destructive/40 p-4">
        <div>
          <h2 className="text-sm font-medium text-destructive">危险操作</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            注销会永久删除账号及全部笔记/线索/周报，不可恢复。若只想在本机退出，请使用上方「退出登录」
          </p>
        </div>
        <Button
          variant="destructive"
          onClick={() => void handleDeleteAccount()}
          disabled={deleting}
          className="w-full sm:w-auto"
        >
          {deleting ? (
            <>
              <Loader2 className="animate-spin" /> 注销中…
            </>
          ) : (
            <>
              <Trash2 /> 注销账号（删除全部数据）
            </>
          )}
        </Button>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-medium">外观</h2>
        <p className="mt-1 text-xs text-muted-foreground">主题设置保存在本机浏览器</p>
        <div className="mt-2 flex gap-1 rounded-lg bg-secondary p-1">
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon
            return (
              <button
                key={opt.value}
                onClick={() => {
                  setTheme(opt.value)
                  setThemeState(opt.value)
                }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  theme === opt.value
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
