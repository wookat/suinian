import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
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
  Bell,
  BellOff,
  KeyRound,
} from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import { Segmented } from "@/components/ui/segmented"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  deleteAccount,
  verifyAccountDeleted,
  getPreferences,
  updatePreferences,
  deleteTag,
  exportData,
  getMe,
  getTags,
  importData,
  downloadBackup,
  restoreBackup,
  MAX_RESTORE_BYTES,
  renameTag,
  rotateToken,
  regenerateRecoveryCode,
  testConnection,
  MAX_IMPORT_BYTES,
  type ImportSource,
  type ImportResult,
  type ImportFailedItem,
  type RestoreStats,
  getPushConfig,
  sendTestPush,
  getWechatBinding,
  createWechatBindCode,
  unbindWechat,
  type WechatBindingStatus,
  type PushPreferences,
  type TestConnectionResult,
  NetworkError,
} from "@/lib/api"
import { useRetryOnReconnect } from "@/lib/use-retry-on-reconnect"
import { detectPushSupport, currentSubscription, enablePush, disablePush, forgetPushIntent, rememberPushIntent } from "@/lib/push"
import { detachServiceWorker, isOfflineCacheEnabled, setOfflineCacheEnabled } from "@/lib/sw-control"
import { RecoveryCodeCard } from "@/pages/auth"
import type { TagCount } from "@/lib/types"
import { defaultApiBase, loadSettings, saveSettings, useSettingsVersion, type Settings } from "@/lib/settings"
import { loadFontSize, loadTheme, setFontSize, setTheme, type FontSize, type ThemeMode } from "@/lib/theme"
import { cn, KNOWN_ISSUES_URL } from "@/lib/utils"
import { SafetyPromise } from "@/components/safety-promise"

const IMPORT_SOURCES: { value: ImportSource; label: string; hint: string; accept: string }[] = [
  { value: "cubox", label: "Cubox", hint: "支持 Cubox 导出的 CSV / 书签 HTML / txt 文件，或打包为 zip 直接上传（含 md 导出）", accept: ".csv,.html,.htm,.txt,.zip" },
  { value: "flomo", label: "flomo", hint: "支持 flomo 导出的 zip 直接上传（图片自动入库），也支持解压后的 HTML 文件", accept: ".zip,.html,.htm" },
  { value: "notion", label: "Notion", hint: "支持 Notion「Markdown & CSV」导出的 zip（含嵌套页面 / 数据库 / 图片，图片自动入库）", accept: ".zip" },
  { value: "obsidian", label: "Obsidian", hint: "把整个 vault 文件夹压缩为 zip 上传；frontmatter 的 tags/created 会保留，[[内链]] 转为文本", accept: ".zip" },
  { value: "apple-notes", label: "Apple 备忘录", hint: "先用 Mac 免费工具 Exporter 导出 md，再把导出文件夹压缩为 zip 上传；文件夹名会变成标签", accept: ".zip" },
  { value: "markdown", label: "Markdown", hint: "按 --- 分隔线或标题拆条；段落首行为日期时作为原创建时间", accept: ".md,.markdown,.txt" },
  { value: "text", label: "纯文本", hint: "按空行拆条，每段一条笔记", accept: ".txt,.md" },
]

const EXAMPLE_API_BASE = "https://suinian-api.example.workers.dev"

/** 未填 API 地址时的默认值：托管域上是官方实例，自部署时留空由占位提示 */
function apiBasePlaceholder(): string {
  return defaultApiBase() || EXAMPLE_API_BASE
}

/** memos 式可复制 curl 示例；withToken=true 时把真实 token 写进剪贴板文本（不在页面展示） */
function buildCurlExample(apiBaseUrl: string, withToken: boolean): string {
  const base = (apiBaseUrl || apiBasePlaceholder()).trim().replace(/\/$/, "")
  const token = withToken ? loadSettings().apiToken || "YOUR_API_TOKEN" : "YOUR_API_TOKEN"
  return [
    `curl -X POST '${base}/api/notes' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"content": "从 API 记一条碎念"}'`,
  ].join("\n")
}

type PendingConfirm = { title: string; description?: string; confirmLabel: string; run: () => void }

function PendingConfirmDialog({
  pending,
  onClose,
}: {
  pending: PendingConfirm | null
  onClose: () => void
}) {
  return (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ""}
      description={pending?.description}
      confirmLabel={pending?.confirmLabel}
      onConfirm={() => {
        onClose()
        pending?.run()
      }}
      onCancel={onClose}
    />
  )
}

/** 演示数据只在本浏览器：导出 / 备份 / 导入 / 恢复四个真实账号能力在演示模式先说明、不留可点却必失败的按钮 */
function DemoDataNotice({ action }: { action: string }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground" role="status">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        演示数据只保存在当前浏览器，{action}需要登录真实账号；
        <button
          type="button"
          onClick={() => (window.location.hash = "#/auth")}
          className="font-medium text-primary underline underline-offset-2"
        >
          注册 / 登录
        </button>
        后，演示期间记的笔记可一键导入
      </span>
    </p>
  )
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      {children}
    </section>
  )
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
]

const FONT_SIZE_OPTIONS: { value: FontSize; label: string }[] = [
  { value: "small", label: "小" },
  { value: "normal", label: "标准" },
  { value: "large", label: "大" },
  { value: "xlarge", label: "特大" },
]

type SwStatus = {
  supported: boolean
  registered: boolean
  active: boolean
  installing: boolean
  waiting: boolean
  controlling: boolean
  offlineReady: boolean
}

function useSwStatus(): SwStatus | null {
  const [status, setStatus] = useState<SwStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    async function check() {
      if (!("serviceWorker" in navigator)) {
        if (!cancelled)
          setStatus({ supported: false, registered: false, active: false, installing: false, waiting: false, controlling: false, offlineReady: false })
        return
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration()
        let offlineReady = false
        if ("caches" in window) {
          // 只看 key 存在会把「空 precache」当成健康（audit-r271 P1-8 假健康态）：
          // 必须确认 precache 里确实有条目
          const keys = await caches.keys()
          const precacheKey = keys.find((k) => k.includes("precache"))
          if (precacheKey) {
            const entries = await (await caches.open(precacheKey)).keys()
            offlineReady = entries.length > 0
          }
        }
        if (!cancelled)
          setStatus({
            supported: true,
            registered: !!reg,
            active: !!reg?.active,
            installing: !!reg?.installing,
            waiting: !!reg?.waiting,
            controlling: !!navigator.serviceWorker.controller,
            offlineReady,
          })
      } catch {
        if (!cancelled)
          setStatus({ supported: true, registered: false, active: false, installing: false, waiting: false, controlling: false, offlineReady: false })
      }
    }
    void check()
    const t = setInterval(() => void check(), 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])
  return status
}

function SwStatusCard() {
  const status = useSwStatus()
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  // R294 P1-3（docs/decision-r294.md §4）：离线缓存默认关闭的可选项。
  const [offlineOn, setOfflineOn] = useState(() => isOfflineCacheEnabled())
  if (!status) return null
  const ok = status.active && status.offlineReady
  // 安装失败终态（R178 P1-1）：已注册但既无 active 也无 installing —— 新 SW
  // 安装失败后变 redundant，以前会永远显示「安装中」，无失败可见性也无出路
  const failed = status.registered && !status.active && !status.installing
  // 假健康故障态（audit-r271 P1-8）：SW 已 active 但 Workbox precache 缺失/为空，
  // 离线刷新必然 ERR_FAILED 且不能自愈——按故障处理，给出同一条修复出路
  const degraded = status.active && !status.offlineReady && !status.installing && !status.waiting
  const text = !status.supported
    ? "当前浏览器不支持离线缓存（Service Worker）"
    : !offlineOn
      ? "离线缓存已关闭（默认）：在线功能完整，不会因浏览器 Service Worker 卡住而影响登录/注册"
      : ok
        ? `离线可用：页面已缓存，断网也能打开${status.controlling ? "" : "（刷新后接管本页）"}${status.waiting ? "；新版本已就绪，刷新页面完成更新" : ""}`
        : failed
          ? "离线缓存安装失败（可能是网络问题），可点击重试"
          : degraded
            ? "离线缓存不完整（页面预缓存缺失），断网将无法打开页面，可点击修复"
            : status.registered
              ? "离线缓存正在安装中，稍后刷新可生效"
              : "离线缓存未注册，刷新页面重试"
  // 注销卡死的 registration 可能永远不返回（SW 组件 wedge），10s 超时给出
  // 失败原因与用户可自救的路径，而不是无限「重试中…」
  const retry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      // 应用内自愈（R270，audit-r269 P2-4）：只注销当前 registration 后刷新，
      // 会用同一份缓存/同一份卡死脚本再注册一次，wedge 原样复现（R269 实测多次
      // 重试状态不变）。这里把浏览器侧可控的三步都做掉：注销全部 registration →
      // 清空全部 CacheStorage（precache 残留会让新 SW 装到同一份坏缓存上）→
      // 带 cache-busting 查询串重新注册，最后才刷新。
      await Promise.race([
        (async () => {
          const regs = await navigator.serviceWorker.getRegistrations()
          await Promise.all(regs.map((r) => r.unregister().catch(() => false)))
          if ("caches" in window) {
            const keys = await caches.keys()
            await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)))
          }
          await navigator.serviceWorker.register(`/sw.js?reinstall=${Date.now()}`, { scope: "/" })
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
      ])
      window.location.reload()
    } catch (e) {
      setRetrying(false)
      setRetryError(
        e instanceof Error && e.message === "timeout"
          ? "重试超时：浏览器的 Service Worker 组件可能已卡住。请先关闭本站所有标签页后重新打开；若仍失败，在浏览器「站点设置 → 清除数据」里仅清除本站数据后刷新（笔记都在云端，不会丢失）"
          : "重试失败：浏览器拒绝了操作。请关闭本站所有标签页后重开，或在浏览器站点设置里清除本站数据后刷新（笔记都在云端，不会丢失）",
      )
    }
  }
  // R296 P3-2（audit-r295）：SW 是默认关闭的实验性能力，设置卡收进「高级」
  // 折叠区，普通用户不被 Service Worker 细节打扰；开启过的用户默认展开。
  return (
    <Card className="p-5">
      <details className="group" open={offlineOn}>
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>高级：离线与更新（PWA）</span>
          <span className="text-xs text-muted-foreground group-open:hidden">展开</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">收起</span>
        </summary>
      <p
        className={cn(
          "mt-2 flex items-center gap-1.5 text-sm",
          ok && offlineOn ? "text-success" : "text-muted-foreground",
        )}
      >
        {ok || !offlineOn ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
        {text}
      </p>
      {offlineOn && (failed || degraded) && (
        <>
          <Button size="sm" variant="outline" className="mt-2" disabled={retrying} onClick={() => void retry()}>
            {retrying ? "重试中…" : failed ? "重试安装离线缓存" : "修复离线缓存"}
          </Button>
          {retryError && <p className="mt-2 text-xs text-warning">{retryError}</p>}
        </>
      )}
      {/* R294 P1-3（docs/decision-r294.md §4）：离线缓存改为默认关闭的可选项。
          依据：生产 sw_error_reports 直查显示 SW 从未 activated，反而弹窗骚扰并拖慢
          登录/注册；关闭后在线功能完整，想要离线的用户可在这里自行开启。 */}
      {status.supported && (
        <div className="mt-3 flex items-start justify-between gap-4 border-t pt-3 text-sm">
          <label htmlFor="offline-cache-switch" className="min-w-0 cursor-pointer">
            开启离线缓存（实验性）
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              开启后可在断网时浏览已缓存的笔记/线索/周报，并在有新版本时提示刷新。部分浏览器的 Service Worker
              组件会卡住并拖慢登录/注册；若多次安装失败，会自动注销并回到关闭状态。
            </span>
          </label>
          <Switch
            id="offline-cache-switch"
            className="mt-0.5"
            checked={offlineOn}
            onCheckedChange={(on) => {
              setOfflineOn(on)
              setOfflineCacheEnabled(on)
              if (!on) void detachServiceWorker(8_000).finally(() => window.location.reload())
              else window.location.reload()
            }}
          />
        </div>
      )}
      </details>
    </Card>
  )
}

function TagManagerCard() {
  const [tags, setTags] = useState<TagCount[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showLongTail, setShowLongTail] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const settingsVersion = useSettingsVersion()
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    setUnreachable(false)
    getTags()
      .then((t) => {
        if (!cancelled) setTags(t)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setUnreachable(e instanceof NetworkError)
      })
    return () => {
      cancelled = true
    }
  }, [settingsVersion, attempt])

  useRetryOnReconnect(error !== null && unreachable, retry)

  async function refresh() {
    try {
      setTags(await getTags())
      setError(null)
      setUnreachable(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setUnreachable(e instanceof NetworkError)
    }
  }

  async function handleRename(from: string) {
    const to = renameValue.trim().replace(/^#/, "")
    if (!to || to === from) {
      setEditingTag(null)
      return
    }
    const merging = tags?.some((t) => t.tag === to) ?? false
    if (merging) {
      setPendingConfirm({
        title: `合并标签 #${from} → #${to}？`,
        description: `标签 #${to} 已存在，合并后 #${from} 将从所有笔记中替换为 #${to}。`,
        confirmLabel: "确认合并",
        run: () => void performRename(from, to, true),
      })
      return
    }
    await performRename(from, to, false)
  }

  async function performRename(from: string, to: string, merging: boolean) {
    setBusy(true)
    try {
      const affected = await renameTag(from, to)
      setMsg({ ok: true, text: `${merging ? "已合并" : "已重命名"} #${from} → #${to}，影响 ${affected} 条笔记` })
      setEditingTag(null)
      await refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function handleDelete(tag: string, count: number) {
    setPendingConfirm({
      title: `删除标签 #${tag}？`,
      description: `将从 ${count} 条笔记中移除该标签，笔记本身保留。`,
      confirmLabel: "确认删除",
      run: () => void performDelete(tag),
    })
  }

  async function performDelete(tag: string) {
    setBusy(true)
    try {
      const affected = await deleteTag(tag)
      setMsg({ ok: true, text: `已删除 #${tag}，影响 ${affected} 条笔记` })
      await refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-[15px] font-semibold leading-snug">标签管理</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          重命名会全局替换；改名到已有标签即合并；删除仅移除标签，不删笔记
        </p>
      </div>
      {error ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">
            {error}
            {unreachable ? "（会自动重试）" : ""}
          </p>
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw className="size-3.5" /> 重试
          </Button>
        </div>
      ) : tags === null ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 加载中…
        </p>
      ) : tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有标签，AI 分拣或手动编辑后会出现在这里</p>
      ) : (
        <ul className="divide-y">
          {/* 长尾折叠（R150 P2-7）：只用过一次的标签数量多时折叠，避免上百行滚动噪音 */}
          {(showLongTail || tags.filter((t) => t.count <= 1).length <= 10
            ? tags
            : tags.filter((t) => t.count > 1)
          ).map(({ tag, count }) => (
            <li key={tag} className="flex flex-wrap items-center gap-2 py-2">
              {editingTag === tag ? (
                <>
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void handleRename(tag)
                      }
                      if (e.key === "Escape") setEditingTag(null)
                    }}
                    aria-label={`重命名标签 ${tag}`}
                    className="h-8 w-40"
                    autoFocus
                  />
                  <Button size="sm" disabled={busy} onClick={() => void handleRename(tag)}>
                    确定
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingTag(null)}>
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    #{tag}
                    <span className="ml-1.5 text-xs text-muted-foreground">{count} 条</span>
                  </span>
                  <button
                    onClick={() => {
                      setEditingTag(tag)
                      setRenameValue(tag)
                    }}
                    disabled={busy}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    重命名/合并
                  </button>
                  <button
                    onClick={() => handleDelete(tag, count)}
                    disabled={busy}
                    className="text-xs font-medium text-destructive hover:underline"
                  >
                    删除
                  </button>
                </>
              )}
            </li>
          ))}
          {!showLongTail && tags.filter((t) => t.count <= 1).length > 10 && (
            <li className="py-2">
              <button
                onClick={() => setShowLongTail(true)}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                展开 {tags.filter((t) => t.count <= 1).length} 个只用过一次的标签
              </button>
            </li>
          )}
        </ul>
      )}
      {msg && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm",
            msg.ok ? "text-success" : "text-destructive",
          )}
        >
          {msg.ok ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
          {msg.text}
        </p>
      )}
      <PendingConfirmDialog pending={pendingConfirm} onClose={() => setPendingConfirm(null)} />
    </Card>
  )
}

/** 浏览器通知：Web Push 订阅开关 + 测试推送（待办到点提醒、每日回顾推送都走这个通道） */
function BrowserNotificationsCard() {
  const support = detectPushSupport()
  const [state, setState] = useState<"loading" | "off" | "on" | "server-off">("loading")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const settingsVersion = useSettingsVersion()

  useEffect(() => {
    let cancelled = false
    const s = loadSettings()
    if (s.useMock || !s.apiBaseUrl || !s.apiToken || support !== "ok") return
    void (async () => {
      try {
        const [config, sub] = await Promise.all([getPushConfig(), currentSubscription()])
        if (cancelled) return
        if (!config.enabled) {
          setState("server-off")
          return
        }
        const subscribed = !!sub && config.subscriptions.some((x) => x.endpoint === sub.endpoint)
        const on = subscribed && Notification.permission === "granted"
        // R314 前开的推送没有意图标记：在这里确认两侧一致后补上，之后订阅丢失才能自动补回
        if (on) rememberPushIntent()
        setState(on ? "on" : "off")
      } catch {
        if (!cancelled) setState("off")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settingsVersion, support])

  const s = loadSettings()
  if (s.useMock || !s.apiBaseUrl || !s.apiToken) return null

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-[15px] font-semibold leading-snug">浏览器通知</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          开启后，待办到点提醒和每日回顾会直接推到这台设备的系统通知（支持多设备各自开启）
        </p>
      </div>
      {support === "ios-needs-install" ? (
        <p className="text-sm text-muted-foreground">
          iOS Safari 需先把碎念「添加到主屏幕」安装为 App（需 iOS 16.4+），再从主屏幕打开后在此开启通知
        </p>
      ) : support === "unsupported" ? (
        <p className="text-sm text-muted-foreground">当前浏览器不支持 Web Push 通知</p>
      ) : state === "server-off" ? (
        <p className="text-sm text-muted-foreground">服务端未配置推送（VAPID 密钥），自部署请参考 docs/push.md</p>
      ) : state === "loading" ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 加载中…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {state === "on" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await disablePush()
                    setState("off")
                    setMsg({ ok: true, text: "已关闭本设备的浏览器通知" })
                  })
                }
              >
                <BellOff /> 关闭通知
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await sendTestPush()
                    setMsg({ ok: true, text: "测试推送已发出，稍等几秒应弹出系统通知" })
                  })
                }
              >
                {busy ? <Loader2 className="animate-spin" /> : <Bell />} 发送测试推送
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await enablePush()
                  setState("on")
                  setMsg({ ok: true, text: "已开启！可点「发送测试推送」验证" })
                })
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : <Bell />} 开启浏览器通知
            </Button>
          )}
        </div>
      )}
      {msg && (
        <p
          className={cn(
            "flex items-center gap-1.5 text-sm",
            msg.ok ? "text-success" : "text-destructive",
          )}
        >
          {msg.ok ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="size-4 shrink-0" />}
          {msg.text}
        </p>
      )}
    </Card>
  )
}

/** 推送偏好：每日回顾 / 待办提醒各自可开关（默认开，存服务端 user preferences） */
function PushPreferencesCard() {
  const [prefs, setPrefs] = useState<PushPreferences | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // fail closed like WechatBindingCard: only mention WeChat when a channel is live
  const [wechatOn, setWechatOn] = useState(false)
  const [loadFailed, setLoadFailed] = useState<{ unreachable: boolean } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const settingsVersion = useSettingsVersion()
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    const s = loadSettings()
    if (s.useMock || !s.apiBaseUrl || !s.apiToken) return
    setError(null)
    setLoadFailed(null)
    getPreferences()
      .then((p) => {
        if (!cancelled) setPrefs(p)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoadFailed({ unreachable: e instanceof NetworkError })
      })
    getWechatBinding()
      .then((st) => {
        if (!cancelled) setWechatOn(Boolean(st.configured || st.kf_configured))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [settingsVersion, attempt])

  useRetryOnReconnect(loadFailed?.unreachable === true, retry)

  const s = loadSettings()
  if (s.useMock || !s.apiBaseUrl || !s.apiToken) return null

  async function toggle(key: "daily_review_push" | "todo_reminder_push") {
    if (!prefs || busy) return
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    setBusy(true)
    setError(null)
    try {
      setPrefs(await updatePreferences({ [key]: next[key] }))
    } catch (e) {
      // 请求超时不代表服务端没生效（R189 P3-3）：回读服务端真实状态收敛 UI，
      // 避免盲目回滚后用户反复点击让开关来回翻转
      try {
        setPrefs(await getPreferences())
      } catch {
        setPrefs(prefs)
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const OPTIONS: { key: "daily_review_push" | "todo_reminder_push"; label: string; hint: string }[] = [
    {
      key: "daily_review_push",
      label: "每日回顾推送",
      hint: `每天早上 08:00 把「今日回顾」推到浏览器通知${wechatOn ? "（已绑微信时同步推微信）" : ""}`,
    },
    {
      key: "todo_reminder_push",
      label: "待办提醒推送",
      hint: `带时间的待办提前 30 分钟推浏览器通知，全天待办当天 08:00 提醒${wechatOn ? "；已绑微信时上午推当天清单" : ""}`,
    },
  ]

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-[15px] font-semibold leading-snug">推送偏好</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{`控制浏览器通知${wechatOn ? "与微信 bot" : ""}的主动推送，默认全开；关闭后当天即生效`}</p>
      </div>
      {error && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-destructive">
            {error}
            {loadFailed?.unreachable ? "（会自动重试）" : ""}
          </p>
          {loadFailed && (
            <Button size="sm" variant="outline" onClick={retry}>
              <RefreshCw className="size-3.5" /> 重试
            </Button>
          )}
        </div>
      )}
      {prefs === null && !error ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 加载中…
        </p>
      ) : prefs ? (
        <div className="divide-y rounded-xl border">
          {OPTIONS.map((opt) => (
            <div key={opt.key} className="flex items-start justify-between gap-4 px-3.5 py-3">
              <label htmlFor={`pref-${opt.key}`} className="min-w-0 cursor-pointer">
                <span className="block text-sm font-medium">{opt.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{opt.hint}</span>
              </label>
              <Switch
                id={`pref-${opt.key}`}
                checked={prefs[opt.key]}
                disabled={busy}
                onCheckedChange={() => void toggle(opt.key)}
                className="mt-0.5"
              />
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

function WechatBindingCard() {
  const [status, setStatus] = useState<WechatBindingStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState<{ unreachable: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [bindCode, setBindCode] = useState<{ code: string; ttl_minutes: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const settingsVersion = useSettingsVersion()
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    const s = loadSettings()
    if (s.useMock || !s.apiBaseUrl || !s.apiToken) return
    setLoadFailed(null)
    getWechatBinding()
      .then((st) => {
        if (!cancelled) setStatus(st)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadFailed({ unreachable: e instanceof NetworkError })
      })
    return () => {
      cancelled = true
    }
  }, [settingsVersion, attempt])

  useRetryOnReconnect(status === null && loadFailed?.unreachable === true, retry)

  const s = loadSettings()
  if (s.useMock || !s.apiBaseUrl || !s.apiToken) return null
  // 两条微信通道都未开通时保留一行说明（R150 D-3）：让用户知道通道存在，
  // 但不挂绑定入口，不做「即将开放」承诺
  if (status && !status.configured && !status.kf_configured)
    return (
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold leading-snug">微信绑定</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">微信随手记通道暂未开通，开通后可在这里绑定微信直接发消息记碎念。</p>
      </Card>
    )
  // 状态请求失败（如 token 失效）时能力未知，按未开通处理整卡隐藏（fail closed）
  if (status === null && loadFailed) return null

  async function generate() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await createWechatBindCode()
      setBindCode({ code: r.code, ttl_minutes: r.ttl_minutes })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await unbindWechat()
      setBindCode(null)
      setStatus(await getWechatBinding())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h3 className="text-[15px] font-semibold leading-snug">微信绑定</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          两条官方通道共用同一个绑定码：公众号适合随手输入（文字/链接/图片/语音）；企微微信客服还能接住微信内转发的文章链接、文件与小程序卡片（合并转发的聊天记录官方接口暂不支持）。把绑定码发给任一通道即可绑定，发「解绑」解除。
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {status === null ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 加载中…
        </p>
      ) : status ? (
        <div className="space-y-3">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>公众号通道：{status.configured ? "已开通 — 关注碎念公众号后发绑定码" : "未开通"}</p>
            <p>企微微信客服通道：{status.kf_configured ? "已开通 — 添加客服会话后发绑定码，可接收转发文章/文件" : "未开通"}</p>
          </div>
          {status.bound || status.kf_bound ? (
            <div className="space-y-2">
              {status.bindings.map((b) => (
                <p key={b.openid_masked} className="flex items-center gap-1.5 text-sm">
                  <CircleCheck className="size-4 text-success" /> 已绑定公众号微信 {b.openid_masked}（{b.created_at}）
                </p>
              ))}
              {(status.kf_bindings ?? []).map((b) => (
                <p key={`kf-${b.openid_masked}`} className="flex items-center gap-1.5 text-sm">
                  <CircleCheck className="size-4 text-success" /> 已绑定企微客服微信 {b.openid_masked}（{b.created_at}）
                </p>
              ))}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void unbind()}>
                解除绑定
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {bindCode ? (
                <div className="space-y-1">
                  <p className="font-mono text-2xl tracking-widest">{bindCode.code}</p>
                  <p className="text-xs text-muted-foreground">
                    把这个 6 位码发给公众号或企微客服（{bindCode.ttl_minutes} 分钟内有效），收到「绑定成功」回复后刷新本页
                  </p>
                </div>
              ) : null}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void generate()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {bindCode ? "重新生成绑定码" : "生成绑定码"}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Card>
  )
}

function formatLastUsed(iso: string): string {
  // API stores UTC "YYYY-MM-DD HH:MM:SS"
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SettingsPage() {
  const [settings, setSettings] = useState(loadSettings())
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [theme, setThemeState] = useState<ThemeMode>(loadTheme)
  const [fontSize, setFontSizeState] = useState<FontSize>(loadFontSize)
  const [copied, setCopied] = useState(false)
  const [curlCopied, setCurlCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null)
  const [accountMsg, setAccountMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null)
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [exporting, setExporting] = useState<"json" | "markdown" | "backup" | null>(null)
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [importSource, setImportSource] = useState<ImportSource>("cubox")
  const [guideOpen, setGuideOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null)
  const [importFailed, setImportFailed] = useState<ImportFailedItem[]>([])
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [lastUsedAt, setLastUsedAt] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  useSettingsVersion()
  const demoOnly = loadSettings().useMock

  useEffect(() => {
    const s = loadSettings()
    if (s.useMock || !s.apiBaseUrl || !s.apiToken) return
    getMe()
      .then((me) => setLastUsedAt(me.last_used_at))
      .catch(() => {})
  }, [])

  async function handleImportFile(file: File) {
    if (importing) return
    if (file.size > MAX_IMPORT_BYTES) {
      setImportMsg({ ok: false, text: "文件过大：最大支持 20MB" })
      return
    }
    setImporting(true)
    setImportMsg(null)
    setImportProgress(null)
    setImportFailed([])
    try {
      const result: ImportResult = await importData(file, importSource, (done, total) =>
        setImportProgress({ done, total }),
      )
      const { stats } = result
      setImportFailed(result.failed_items)
      setImportMsg({
        ok: true,
        text: `导入完成：共解析 ${stats.total} 条，成功 ${stats.imported} 条，跳过重复 ${stats.skipped} 条${stats.failed > 0 ? `，失败 ${stats.failed} 条` : ""}${(stats.assets_dropped ?? 0) > 0 ? `；${stats.assets_dropped} 张图片超出上限未导入（每条最多 3 张、单张 5MB、单次共 100 张），正文中占位标记对应的原图请单独上传` : ""}${stats.truncated ? "；已达单次 2000 条导入上限，如文件不止 2000 条，请拆分后分批导入剩余部分" : ""}。AI 分拣会在后台排队完成（通常几分钟内），线索/图谱随后更新`,
      })
    } catch (e) {
      setImportMsg({ ok: false, text: e instanceof Error ? e.message : "导入失败，请稍后重试" })
    } finally {
      setImporting(false)
      setImportProgress(null)
      if (importInputRef.current) importInputRef.current.value = ""
    }
  }

  function downloadImportFailures() {
    const lines = importFailed.map((f) => `${f.item}\t${f.reason}`)
    const blob = new Blob([`条目\t原因\n${lines.join("\n")}\n`], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `suinian-import-failed-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleRestoreFile(file: File) {
    if (restoring) return
    if (file.size > MAX_RESTORE_BYTES) {
      setRestoreMsg({ ok: false, text: "备份文件过大：最大支持 200MB" })
      return
    }
    setRestoring(true)
    setRestoreMsg(null)
    try {
      const stats: RestoreStats = await restoreBackup(file)
      setRestoreMsg({
        ok: true,
        text: `恢复完成：笔记 ${stats.notes_imported}/${stats.notes_total} 条（跳过重复 ${stats.notes_skipped} 条）${(stats.sensitive_skipped ?? 0) > 0 ? `，跳过脱敏占位的敏感笔记 ${stats.sensitive_skipped} 条（迁移敏感内容请用勾选「包含敏感内容」的完整备份）` : ""}，媒体 ${stats.media_imported} 个${(stats.media_oversized ?? 0) > 0 ? `，超过大小上限跳过 ${stats.media_oversized} 个` : ""}${stats.media_failed > 0 ? `，导入失败 ${stats.media_failed} 个` : ""}${(stats.reports_imported ?? 0) > 0 || (stats.reports_skipped ?? 0) > 0 ? `，历史报告导入 ${stats.reports_imported} 份${(stats.reports_skipped ?? 0) > 0 ? `（跳过重复/无效 ${stats.reports_skipped} 份）` : ""}` : ""}${(stats.threads_rebuilt ?? 0) > 0 ? `，${stats.threads_rebuilt} 条线索归组将由后台聚类重建` : ""}。AI 分拣/线索/图谱会在后台陆续补全`,
      })
    } catch (e) {
      setRestoreMsg({ ok: false, text: e instanceof Error ? e.message : "恢复失败，请稍后重试" })
    } finally {
      setRestoring(false)
      if (restoreInputRef.current) restoreInputRef.current.value = ""
    }
  }

  async function handleExport(format: "json" | "markdown" | "backup") {
    if (exporting) return
    // 敏感明文整包导出需密码复核（与后端 x-suinian-password 校验配对）
    let password: string | undefined
    if (includeSensitive) {
      const input = window.prompt("导出将包含敏感内容明文，请输入账号密码验证：")
      if (input === null) return
      password = input
    }
    setExporting(format)
    setExportMsg(null)
    try {
      const { blob, filename } =
        format === "backup"
          ? await downloadBackup(includeSensitive, password)
          : await exportData(format, includeSensitive, password)
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

  async function copyCurl() {
    try {
      await navigator.clipboard.writeText(buildCurlExample(loadSettings().apiBaseUrl, true))
      setCurlCopied(true)
      setTimeout(() => setCurlCopied(false), 2000)
    } catch {
      setAccountMsg({ ok: false, text: "复制失败，请手动选中复制" })
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

  function handleRotate() {
    if (rotating) return
    setPendingConfirm({
      title: "轮换 API token？",
      description: "轮换后旧 token 立即失效，其它设备（微信桥 / Android）需同步更新。",
      confirmLabel: "确认轮换",
      run: () => void performRotate(),
    })
  }

  async function performRotate() {
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

  function handleRegenerateRecovery() {
    if (regenerating) return
    setPendingConfirm({
      title: "重新生成恢复码？",
      description: "重新生成后旧恢复码立即作废，新码只显示一次。",
      confirmLabel: "确认重新生成",
      run: () => void performRegenerateRecovery(),
    })
  }

  async function performRegenerateRecovery() {
    setRegenerating(true)
    setAccountMsg(null)
    try {
      setNewRecoveryCode(await regenerateRecoveryCode())
    } catch (e) {
      setAccountMsg({ ok: false, text: e instanceof Error ? e.message : "生成失败，请稍后重试" })
    } finally {
      setRegenerating(false)
    }
  }

  function handleLogout() {
    setPendingConfirm({
      title: "退出登录？",
      description: "只会清除本机保存的 token 与设置，云端笔记/线索/周报全部保留，重新登录即可找回。",
      confirmLabel: "退出登录",
      run: performLogout,
    })
  }

  function performLogout() {
    forgetPushIntent()
    saveSettings({ apiBaseUrl: "", apiToken: "", useMock: true, onboarded: false, tourSeen: true })
    window.location.hash = "#/"
    window.location.reload()
  }

  async function handleDeleteAccount() {
    if (deleting || deleteConfirmText !== "注销") return
    setDeleting(true)
    setAccountMsg(null)
    try {
      await deleteAccount()
      forgetPushIntent()
      saveSettings({ apiBaseUrl: "", apiToken: "", useMock: true, onboarded: false, tourSeen: true })
      window.location.hash = "#/"
      window.location.reload()
    } catch (e) {
      // 请求超时/网络中断不代表服务端没删：探测 token 是否已失效，避免
      // 「其实已注销却提示失败」或「以为成功其实没删」两种误导
      const gone = await verifyAccountDeleted()
      if (gone) {
        saveSettings({ apiBaseUrl: "", apiToken: "", useMock: true, onboarded: false, tourSeen: true })
        window.location.hash = "#/"
        window.location.reload()
        return
      }
      setAccountMsg({ ok: false, text: e instanceof Error ? e.message : "注销失败，请稍后重试" })
      setDeleting(false)
    }
  }

  /** 切到真实 API 但没填地址时，托管域自动补官方实例地址（与注册/登录页同一默认值） */
  function withDefaultBase(s: Settings): Settings {
    if (s.useMock || s.apiBaseUrl.trim()) return s
    const base = defaultApiBase()
    return base ? { ...s, apiBaseUrl: base } : s
  }

  function save() {
    const filled = withDefaultBase(settings)
    const next =
      filled.useMock && filled.apiBaseUrl.trim() && filled.apiToken.trim()
        ? { ...filled, useMock: false }
        : filled
    setSettings(next)
    saveSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleTest() {
    if (testing) return
    const filled = withDefaultBase(settings)
    setSettings(filled)
    saveSettings(filled)
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testConnection())
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-8">
      <SettingsGroup title="连接与账号">
      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">数据源</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            演示模式使用本地示例数据，无需后端即可体验完整功能
          </p>
          <Segmented
            className="mt-3"
            aria-label="数据源"
            value={settings.useMock ? "mock" : "api"}
            onValueChange={(v) => setSettings((s) => ({ ...s, useMock: v === "mock" }))}
            options={[
              { value: "mock", label: "演示模式" },
              { value: "api", label: "真实 API" },
            ]}
          />
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
            placeholder={apiBasePlaceholder()}
            value={settings.apiBaseUrl}
            onChange={(e) => {
              setTestResult(null)
              setSettings((s) => ({ ...s, apiBaseUrl: e.target.value }))
            }}
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
            onChange={(e) => {
              setTestResult(null)
              setSettings((s) => ({ ...s, apiToken: e.target.value }))
            }}
          />
          <p className="text-xs text-muted-foreground">仅保存在本机浏览器 localStorage</p>
          <div className="space-y-1 rounded-md bg-muted/60 p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">用 API 直接记一条（curl 示例）</span>
              <button
                onClick={() => void copyCurl()}
                className="text-xs font-medium text-primary hover:underline"
              >
                {curlCopied ? "已复制" : "复制"}
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
              {buildCurlExample(settings.apiBaseUrl, false)}
            </pre>
          </div>
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
                ? "text-success"
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

      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">账号</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
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
            onClick={handleRotate}
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
          <Button
            variant="outline"
            onClick={handleRegenerateRecovery}
            disabled={regenerating}
            className="w-full sm:w-auto"
          >
            {regenerating ? (
              <>
                <Loader2 className="animate-spin" /> 生成中…
              </>
            ) : (
              <>
                <KeyRound /> 重新生成恢复码
              </>
            )}
          </Button>
          <Button variant="outline" onClick={handleLogout} className="w-full sm:w-auto">
            <LogOut /> 退出登录
          </Button>
        </div>
        {newRecoveryCode && (
          <RecoveryCodeCard code={newRecoveryCode} onDone={() => setNewRecoveryCode(null)} />
        )}
        <p className="text-xs text-muted-foreground">
          恢复码是忘记密码时找回账号的唯一方式，丢失或泄露时可在这里重新生成（旧码同时作废）。用恢复码找回账号会同时作废所有旧 token：其他设备、浏览器扩展、MCP/API 集成需重新登录或重新配置
        </p>
        <p className="text-xs text-muted-foreground">
          退出登录仅清除本机登录状态，云端数据不受影响，重新登录即可找回全部笔记
        </p>
        {lastUsedAt && (
          <p className="text-xs text-muted-foreground">
            token 上次使用时间：{formatLastUsed(lastUsedAt)}（若非本人操作，建议立即轮换 token）
          </p>
        )}
        {accountMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              accountMsg.ok ? "text-success" : "text-destructive",
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
      </SettingsGroup>

      <SettingsGroup title="通知与渠道">
      <WechatBindingCard />

      <BrowserNotificationsCard />

      <PushPreferencesCard />
      </SettingsGroup>

      <SettingsGroup title="数据">
      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">导出数据</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            导出全部笔记（含待分拣）/线索/周报。敏感笔记默认脱敏（正文打码，其语音/图片/文件原件也不打包），勾选后才会明文导出。正文为近似原文：空白/换行/零宽字符可能被归一化
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={includeSensitive}
            onCheckedChange={(v) => setIncludeSensitive(v === true)}
          />
          包含敏感内容（明文导出密码等加密笔记，含其附件原件）
        </label>
        {includeSensitive && (
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <CircleAlert className="size-4 shrink-0" />
            注意：导出的文件将包含敏感笔记的明文（如密码），请妥善保管，不要上传到不可信的地方。恢复导入时会重新加密存储
          </p>
        )}
        <p className="text-xs text-muted-foreground" role="status">
          当前导出口径：
          {includeSensitive
            ? "包含敏感内容明文（完整灾备/搬家包）"
            : "敏感内容已脱敏（正文为占位符、附件不打包）——用作唯一灾备或迁移敏感笔记请先勾选上方「包含敏感内容」"}
        </p>
        {demoOnly && <DemoDataNotice action="导出与完整备份" />}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            onClick={() => void handleExport("backup")}
            disabled={demoOnly || exporting !== null}
            className="w-full sm:w-auto"
          >
            {exporting === "backup" ? (
              <>
                <Loader2 className="animate-spin" /> 打包中，请勿关闭页面…
              </>
            ) : (
              <>
                <Download /> 下载完整备份（zip 含媒体）
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleExport("json")}
            disabled={demoOnly || exporting !== null}
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
            disabled={demoOnly || exporting !== null}
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
        <p className="text-xs text-muted-foreground">
          完整备份包含全部笔记字段、历史周报/月报与语音/图片/文件原件（敏感笔记的附件原件仅在勾选敏感内容时打包），可在下方「从完整备份恢复」搬家到新账号/新实例；线索归组不随包迁移，恢复后由后台聚类自动重建
        </p>
        {exportMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              exportMsg.ok ? "text-success" : "text-destructive",
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

      <TagManagerCard />

      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">最近删除</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            删除的笔记保留 30 天，期间可恢复或立即彻底删除，到期自动清理
          </p>
        </div>
        <Button variant="outline" onClick={() => (window.location.hash = "#/trash")} className="w-full sm:w-auto">
          <Trash2 /> 打开最近删除
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">导入数据</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            从 Cubox / flomo / Notion / Obsidian / Apple 备忘录 / Markdown / 纯文本导出文件批量导入笔记，保留原创建时间与标签；同一时间且内容相同的条目视为重复自动跳过，可安心重复导入同一文件（单文件最大 20MB）
          </p>
        </div>
        <Segmented
          wrap
          aria-label="导入来源"
          value={importSource}
          onValueChange={(v) => {
            setImportSource(v)
            setImportMsg(null)
            setImportFailed([])
          }}
          options={IMPORT_SOURCES.map((o) => ({ value: o.value, label: o.label }))}
        />
        <p className="text-xs text-muted-foreground">
          {IMPORT_SOURCES.find((o) => o.value === importSource)?.hint}
        </p>
        {demoOnly && <DemoDataNotice action="导入" />}
        <input
          ref={importInputRef}
          type="file"
          accept={IMPORT_SOURCES.find((o) => o.value === importSource)?.accept}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
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
                在「设置 → 账号详情 → 导出所有数据（HTML）」拿到 zip 直接上传（图片一并导入）；Notion 在页面菜单「导出 →
                Markdown & CSV（含子页面）」拿到 zip 直接上传；Obsidian 把整个 vault 文件夹压缩为 zip；Apple 备忘录用 Mac App
                Store 免费工具「Exporter」导出 Markdown 后压缩为 zip；其他工具导出 Markdown / 纯文本也可。
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
              提示：flomo / Notion / Obsidian / Apple 备忘录 zip 里引用的图片会自动存入图床；来源选错时会提示「未能解析出笔记」，不会写入脏数据。
            </p>
          </div>
        )}
        <Button
          variant="outline"
          onClick={() => importInputRef.current?.click()}
          disabled={demoOnly || importing}
          className="w-full sm:w-auto"
        >
          {importing ? (
            <>
              <Loader2 className="animate-spin" />
              {importProgress ? `导入中 ${importProgress.done}/${importProgress.total}，请勿关闭页面…` : "导入中，请勿关闭页面…"}
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
              importMsg.ok ? "text-success" : "text-destructive",
            )}
          >
            {importMsg.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            <span>
              {importMsg.text}
              {importMsg.ok && (
                <a href="#/" className="ml-2 underline underline-offset-2">
                  去时间线查看
                </a>
              )}
            </span>
          </p>
        )}
        {importing && importProgress && importProgress.total > 0 && (
          <Progress
            className="h-1.5"
            aria-label="导入进度"
            value={Math.round((importProgress.done / importProgress.total) * 100)}
          />
        )}
        {importFailed.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{importFailed.length} 个条目未完全导入（图片缺失或解析失败）</span>
            <button
              onClick={downloadImportFailures}
              className="font-medium text-primary underline underline-offset-2"
            >
              下载失败清单
            </button>
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug">从完整备份恢复</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            导入「下载完整备份」导出的 zip：笔记保留原时间/标签/分类，语音/图片/文件原件重新入库；已存在的同一条笔记（按备份内的笔记 ID）自动跳过，可安心重复恢复（最大 200MB）。注意：未勾选敏感内容的脱敏备份只含占位符，恢复时会跳过这些敏感笔记——迁移请用包含敏感内容的完整备份
          </p>
        </div>
        {demoOnly && <DemoDataNotice action="从备份恢复" />}
        <input
          ref={restoreInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleRestoreFile(f)
          }}
        />
        <Button
          variant="outline"
          onClick={() => restoreInputRef.current?.click()}
          disabled={demoOnly || restoring}
          className="w-full sm:w-auto"
        >
          {restoring ? (
            <>
              <Loader2 className="animate-spin" /> 恢复中，请勿关闭页面…
            </>
          ) : (
            <>
              <Upload /> 选择备份 zip 恢复
            </>
          )}
        </Button>
        {restoreMsg && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-sm",
              restoreMsg.ok ? "text-success" : "text-destructive",
            )}
          >
            {restoreMsg.ok ? (
              <CircleCheck className="size-4 shrink-0" />
            ) : (
              <CircleAlert className="size-4 shrink-0" />
            )}
            <span>
              {restoreMsg.text}
              {restoreMsg.ok && (
                <a href="#/" className="ml-2 underline underline-offset-2">
                  去时间线查看
                </a>
              )}
            </span>
          </p>
        )}
      </Card>
      </SettingsGroup>

      <SettingsGroup title="外观与高级">
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold leading-snug">外观</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">主题设置保存在本机浏览器</p>
        <p className="mt-4 text-xs font-medium text-muted-foreground">主题</p>
        <Segmented
          className="mt-1.5"
          aria-label="主题"
          value={theme}
          onValueChange={(v) => {
            setTheme(v)
            setThemeState(v)
          }}
          options={THEME_OPTIONS}
        />
        <p className="mt-4 text-xs font-medium text-muted-foreground">字号</p>
        <Segmented
          className="mt-1.5"
          aria-label="字号"
          value={fontSize}
          onValueChange={(v) => {
            setFontSize(v)
            setFontSizeState(v)
          }}
          options={FONT_SIZE_OPTIONS}
        />
      </Card>

      <SwStatusCard />

      <Card className="p-5">
        <h3 className="text-[15px] font-semibold leading-snug">关于</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          碎念 Suinian — 什么都能丢的 AI 收件箱。往 Web / Android /
          剪藏扩展随手一丢，AI 帮你分拣、串线索、随时找到。
        </p>
        <h4 className="mt-3 text-xs font-medium">安全承诺</h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground" data-testid="safety-promise">
          <SafetyPromise />
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          <a href={KNOWN_ISSUES_URL} target="_blank" rel="noreferrer" className="underline hover:text-foreground" data-testid="known-issues-link">
            已知问题清单（beta）
          </a>
        </p>
      </Card>
      </SettingsGroup>

      <SettingsGroup title="危险操作">
      <Card className="space-y-4 border-destructive/40 bg-destructive/[0.03] p-5">
        <div>
          <h3 className="text-[15px] font-semibold leading-snug text-destructive">危险操作</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            注销会永久删除账号及全部笔记/线索/周报，不可恢复。若只想在本机退出，请使用上方「退出登录」
          </p>
        </div>
        {deleteConfirmOpen ? (
          <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">
              注销将永久删除账号及全部笔记/线索/周报，无法恢复。请输入「注销」两个字确认：
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="注销"
              className="max-w-xs"
              aria-label="输入注销以确认"
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={() => void handleDeleteAccount()}
                disabled={deleting || deleteConfirmText !== "注销"}
              >
                {deleting ? (
                  <>
                    <Loader2 className="animate-spin" /> 注销中…
                  </>
                ) : (
                  <>
                    <Trash2 /> 永久注销
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteConfirmOpen(false)
                  setDeleteConfirmText("")
                }}
                disabled={deleting}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="destructive"
            onClick={() => setDeleteConfirmOpen(true)}
            className="w-full sm:w-auto"
          >
            <Trash2 /> 注销账号（删除全部数据）
          </Button>
        )}
      </Card>
      </SettingsGroup>
      <PendingConfirmDialog pending={pendingConfirm} onClose={() => setPendingConfirm(null)} />
    </div>
  )
}
