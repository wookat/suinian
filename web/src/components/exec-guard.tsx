import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react"
import { Code2, Eye, EyeOff, KeyRound, TriangleAlert } from "lucide-react"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { COPY_CONFIRM, copyNeedsConfirm } from "@/lib/copy-confirm"

/**
 * 原文折叠警示（R304 P0-A → R310 P0-2 → R314 P0-2/P0-3）：服务端在笔记数据上给出折叠标记，
 * 所有展示笔记原文的出口（时间流卡片、问答引用卡片、搜索结果、今日回顾等）
 * 共用本组件——默认折叠原文，用户主动展开才显示（一次点击，不打断流）。
 *
 * 五档强度：
 * - strict：严判据 contains_executable_command 命中，红色警示「含可执行命令」，默认折叠；
 * - broad：宽判据 fold 命中（远程端点 / 取回执行原语 / 编码块 / 混淆书写），
 *   中性提示「含端点/代码形态内容」，默认折叠；
 * - credential：口令 / 密钥 / 连接串口令段（fold_reason=broad:credential），默认折叠，建议标为敏感；
 * - destructive：破坏性命令 rm -rf / dd / DROP TABLE 等（fold_reason=broad:destructive），
 *   默认展示但带红色高警示横幅，不与日常命令备忘同级；
 * - code：本机命令行 / SQL 等日常命令备忘（fold_reason=broad:code），默认展示，
 *   只在正文上方给一行「复制/执行前核对」提示。
 *
 * 复制路径（R314 P0-3）：本组件在自己的正文区域监听 copy 事件（选中 + Ctrl+C / 右键复制 /
 * 展开后复制都会经过这里）——strict / destructive / credential / broad 先弹确认再写剪贴板；
 * code 放行原生复制、只给一行提醒。监听范围只限被标记笔记的正文区，不是全局拦截。
 * 这是用户自己的笔记：不删除、不改写，只避免「不带警示地把原文推到眼前 / 推进终端」。
 */
export type FoldLevel = "strict" | "broad" | "code" | "destructive" | "credential"

export const CODE_COPY_HINT = "命令备忘：复制或执行前请核对来源与参数"
export const CODE_COPIED_HINT = "已复制：执行前请核对来源与参数，勿直接粘贴到终端"
export const DESTRUCTIVE_BANNER = "破坏性命令（会删除/覆写数据）：请勿直接执行，先核对对象与参数"

export function ExecGuardBadge({ level = "strict" }: { level?: FoldLevel }) {
  if (level === "code") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <Code2 className="size-3" />
        命令备忘
      </span>
    )
  }
  if (level === "broad") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Code2 className="size-3" />
        含端点/代码形态内容
      </span>
    )
  }
  if (level === "credential") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <KeyRound className="size-3" />
        含口令/密钥
      </span>
    )
  }
  if (level === "destructive") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
        <TriangleAlert className="size-3" />
        破坏性命令
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
      <TriangleAlert className="size-3" />
      含可执行命令
    </span>
  )
}

const COPY: Record<
  Exclude<FoldLevel, "code" | "destructive">,
  { folded: string; revealed: string; help: string; border: string; pill: string; text: string }
> = {
  strict: {
    folded: "含可执行命令，已折叠",
    revealed: "含可执行命令，请勿直接复制执行",
    help: "这条笔记包含可执行命令或危险指令（如下载执行远程代码）。内容未被修改，展开即可查看；请勿直接复制执行。",
    border: "border-red-500/30 bg-red-500/5",
    pill: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    text: "text-red-700 dark:text-red-400",
  },
  broad: {
    folded: "含端点/代码形态内容，已折叠",
    revealed: "含端点或代码形态内容，仅供查阅，请勿直接执行",
    help: "这条笔记含远程地址、命令形态代码或编码内容（按宽判据折叠，可能只是技术备忘）。内容未被修改，展开即可查看；请勿直接粘贴到终端执行。",
    border: "border-amber-500/30 bg-amber-500/5",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    text: "text-amber-700 dark:text-amber-400",
  },
  credential: {
    folded: "含口令/密钥类内容，已折叠",
    revealed: "含口令/密钥类内容，建议标为敏感笔记加密保存",
    help: "这条笔记含口令、密钥或连接串口令段（按形态判据折叠，可能有误判）。内容未被修改，展开即可查看；问答区只给占位，不逐字转写。",
    border: "border-amber-500/30 bg-amber-500/5",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    text: "text-amber-700 dark:text-amber-400",
  },
}

function selectionText(): string {
  return typeof window === "undefined" ? "" : (window.getSelection()?.toString() ?? "")
}

/**
 * 被标记笔记正文的复制守卫：包一层 div 监听 copy 事件（选中 + Ctrl+C、右键「复制」都会触发）。
 * 需确认的强度：阻止原生复制、记下选中文本、弹确认；确认后再用 clipboard API 写入。
 * code 强度：放行原生复制，显示一行提醒。
 */
export function CopyGuard({ level, children, className }: { level: FoldLevel; children: ReactNode; className?: string }) {
  const [pending, setPending] = useState<string | null>(null)
  const [hint, setHint] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )
  function onCopy(e: ClipboardEvent<HTMLDivElement>) {
    const text = selectionText()
    if (!text) return
    if (!copyNeedsConfirm(level)) {
      setHint(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setHint(false), 2500)
      return
    }
    e.preventDefault()
    setPending(text)
  }
  const copy = COPY_CONFIRM[level]
  return (
    <div className={className} data-copy-guard={level} onCopy={onCopy}>
      {children}
      {hint && (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {CODE_COPIED_HINT}
        </p>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={copy.title}
        description={copy.description}
        confirmLabel="仍要复制"
        onConfirm={() => {
          const text = pending ?? ""
          setPending(null)
          navigator.clipboard.writeText(text).catch(() => {
            // clipboard unavailable
          })
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  )
}

export function ExecGuard({
  children,
  compact = false,
  level = "strict",
}: {
  children: ReactNode
  /** 紧凑模式（回顾卡等小空间）：提示文案缩短 */
  compact?: boolean
  level?: FoldLevel
}) {
  const [revealed, setRevealed] = useState(false)
  if (level === "code") {
    return (
      <CopyGuard level="code" className="min-w-0 flex-1">
        <div data-fold-level="code">
          <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Code2 className="mt-0.5 size-3.5 shrink-0" />
            {CODE_COPY_HINT}
          </p>
          {children}
        </div>
      </CopyGuard>
    )
  }
  if (level === "destructive") {
    return (
      <CopyGuard level="destructive" className="min-w-0 flex-1">
        <div data-fold-level="destructive" className="rounded-lg border border-red-500/40 bg-red-500/5 p-2.5">
          <p role="alert" className="mb-1.5 flex items-start gap-1.5 text-xs font-medium leading-relaxed text-red-700 dark:text-red-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {DESTRUCTIVE_BANNER}
          </p>
          {children}
        </div>
      </CopyGuard>
    )
  }
  const copy = COPY[level]
  const Icon = level === "broad" ? Code2 : level === "credential" ? KeyRound : TriangleAlert
  if (!revealed) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          setRevealed(true)
        }}
        aria-expanded={false}
        data-fold-level={level}
        className={`flex w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border p-2.5 text-left ${copy.border}`}
      >
        <span className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium ${copy.pill}`}>
          <Icon className="size-3" /> {copy.folded}
        </span>
        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-secondary px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Eye className="size-3" /> 展开查看
        </span>
        {!compact && <span className="w-full text-xs leading-relaxed text-muted-foreground">{copy.help}</span>}
      </button>
    )
  }
  return (
    <CopyGuard level={level} className="min-w-0 flex-1">
      <div data-fold-level={level}>
        <p className={`mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed ${copy.text}`}>
          <Icon className="mt-0.5 size-3.5 shrink-0" />
          {copy.revealed}
        </p>
        {children}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setRevealed(false)
          }}
          aria-expanded={true}
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <EyeOff className="size-3" /> 收起
        </button>
      </div>
    </CopyGuard>
  )
}
