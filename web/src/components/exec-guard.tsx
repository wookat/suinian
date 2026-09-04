import { useEffect, useRef, useState, type ClipboardEvent, type ComponentProps, type ReactNode } from "react"
import { Code2, Eye, EyeOff, KeyRound, TriangleAlert } from "lucide-react"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Textarea } from "@/components/ui/textarea"
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
 * 复制路径（R314 P0-3 → R316 P1-2）：本组件在自己的正文区域监听 copy 事件（选中 + Ctrl+C / 右键复制 /
 * 展开后复制都会经过这里）——strict / destructive / credential / broad 先弹确认再写剪贴板；
 * code 放行原生复制、只给一行提醒。卡片外的两条路径（整页 Ctrl+A 全选复制、问答答案区选中复制）由
 * PageCopyGuard 兜底：只在**选区确实覆盖了被标记正文**时才接管，普通文字 / 输入框复制不经过它。
 * R318 P1×2 补口：敏感笔记「点击查看」展开后的正文同样包在 CopyGuard（level=sensitive）里；编辑态的
 * textarea 用 CopyGuardTextarea——textarea 内的 copy / cut 事件不冒泡到 PageCopyGuard（输入框放行），
 * 由它自己拦：被标记 / 敏感笔记的编辑框里选中复制、剪切也先确认。
 * 这是用户自己的笔记：不删除、不改写，只避免「不带警示地把原文推到眼前 / 推进终端」。
 */
export type FoldLevel = "strict" | "broad" | "code" | "destructive" | "credential"
/** 复制守卫强度：数据面折叠档 + 敏感笔记（is_sensitive，遮罩展开后 / 编辑态） */
export type CopyGuardLevel = FoldLevel | "sensitive"

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

const CONFIRM_SEVERITY: Record<CopyGuardLevel, number> = { strict: 4, destructive: 3, sensitive: 3, credential: 2, broad: 1, code: 0 }

function isCopyGuardLevel(v: string | null | undefined): v is CopyGuardLevel {
  return v === "strict" || v === "broad" || v === "code" || v === "destructive" || v === "credential" || v === "sensitive"
}

/** 选区覆盖到的、需要确认的被标记正文中最高的一档；未覆盖任何标记正文则 null。 */
export function guardedLevelInSelection(sel: Selection | null, root: ParentNode): CopyGuardLevel | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  let top: CopyGuardLevel | null = null
  const guarded = root.querySelectorAll<HTMLElement>("[data-copy-guard]")
  for (const el of guarded) {
    const level = el.dataset.copyGuard
    if (!isCopyGuardLevel(level) || !copyNeedsConfirm(level)) continue
    for (let i = 0; i < sel.rangeCount; i++) {
      if (!sel.getRangeAt(i).intersectsNode(el)) continue
      if (top === null || CONFIRM_SEVERITY[level] > CONFIRM_SEVERITY[top]) top = level
      break
    }
  }
  return top
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable
}

/**
 * 页面级复制兜底（R316 P1-2，audit-r315 §5.2）：整页 Ctrl+A + Ctrl+C 的 copy 事件目标是 body，不经过任何
 * CopyGuard 容器。这里在 document 上监听一次，只在选区**与某个被标记正文相交**时才接管（弹同一套确认，确认后把
 * 选中文本原样写入剪贴板）；输入框 / 富文本内的复制、CopyGuard 已处理过的事件（defaultPrevented）、
 * 未触及标记正文的普通选区都直接放行——不是全局拦截。
 */
export function PageCopyGuard() {
  const [pending, setPending] = useState<{ text: string; level: CopyGuardLevel } | null>(null)
  useEffect(() => {
    function onCopy(e: globalThis.ClipboardEvent) {
      if (e.defaultPrevented || isEditableTarget(e.target)) return
      const sel = window.getSelection()
      const level = guardedLevelInSelection(sel, document)
      if (level === null) return
      const text = sel?.toString() ?? ""
      if (!text) return
      e.preventDefault()
      setPending({ text, level })
    }
    document.addEventListener("copy", onCopy)
    return () => document.removeEventListener("copy", onCopy)
  }, [])
  const copy = COPY_CONFIRM[pending?.level ?? "strict"]
  return (
    <ConfirmDialog
      open={pending !== null}
      title={copy.title}
      description={`${copy.description}（本次选区覆盖了带此标记的笔记正文。）`}
      confirmLabel="仍要复制"
      onConfirm={() => {
        const text = pending?.text ?? ""
        setPending(null)
        navigator.clipboard.writeText(text).catch(() => {
          // clipboard unavailable
        })
      }}
      onCancel={() => setPending(null)}
    />
  )
}

/**
 * 被标记笔记正文的复制守卫：包一层 div 监听 copy 事件（选中 + Ctrl+C、右键「复制」都会触发）。
 * 需确认的强度：阻止原生复制、记下选中文本、弹确认；确认后再用 clipboard API 写入。
 * code 强度：放行原生复制，显示一行提醒。
 */
export function CopyGuard({ level, children, className }: { level: CopyGuardLevel; children: ReactNode; className?: string }) {
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

/** level 为 null 时不包守卫（普通笔记），否则同 CopyGuard。 */
export function MaybeCopyGuard({ level, children, className }: { level: CopyGuardLevel | null; children: ReactNode; className?: string }) {
  if (level === null) return <>{children}</>
  return (
    <CopyGuard level={level} className={className}>
      {children}
    </CopyGuard>
  )
}

/**
 * 编辑态复制守卫（R318 P1）：textarea 里的 copy / cut 事件目标是输入框，PageCopyGuard 与 CopyGuard 都放行——
 * 被标记 / 敏感笔记进入编辑态后这里自己拦：选中 + Ctrl+C / Ctrl+X / 右键复制都先弹同一套确认；
 * 确认后复制把选中文本写入剪贴板，剪切再把选区从编辑值里去掉（onCutValue）。level 为 null 时是普通 textarea。
 */
export function CopyGuardTextarea({
  level,
  onCutValue,
  ...props
}: ComponentProps<typeof Textarea> & { level: CopyGuardLevel | null; onCutValue?: (next: string) => void }) {
  const [pending, setPending] = useState<{ text: string; cut: { start: number; end: number } | null } | null>(null)
  function intercept(e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) {
    if (level === null || !copyNeedsConfirm(level)) return
    const t = e.currentTarget
    const start = t.selectionStart
    const end = t.selectionEnd
    const text = t.value.slice(start, end)
    if (!text) return
    e.preventDefault()
    setPending({ text, cut: cut ? { start, end } : null })
  }
  const copy = COPY_CONFIRM[level ?? "strict"]
  return (
    <>
      <Textarea
        {...props}
        data-copy-guard={level !== null && copyNeedsConfirm(level) ? level : undefined}
        onCopy={(e) => {
          intercept(e, false)
          props.onCopy?.(e)
        }}
        onCut={(e) => {
          intercept(e, true)
          props.onCut?.(e)
        }}
      />
      <ConfirmDialog
        open={pending !== null}
        title={copy.title}
        description={`${copy.description}（编辑态下选中复制 / 剪切同样会先确认。）`}
        confirmLabel={pending?.cut ? "仍要剪切" : "仍要复制"}
        onConfirm={() => {
          const p = pending
          setPending(null)
          if (!p) return
          navigator.clipboard.writeText(p.text).catch(() => {
            // clipboard unavailable
          })
          if (p.cut && onCutValue) {
            const v = typeof props.value === "string" ? props.value : ""
            onCutValue(v.slice(0, p.cut.start) + v.slice(p.cut.end))
          }
        }}
        onCancel={() => setPending(null)}
      />
    </>
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
