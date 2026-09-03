import { useState, type ReactNode } from "react"
import { Code2, Eye, EyeOff, TriangleAlert } from "lucide-react"

/**
 * 原文折叠警示（R304 P0-A → R310 P0-2）：服务端在笔记数据上给出折叠标记，
 * 所有展示笔记原文的出口（时间流卡片、问答引用卡片、搜索结果、今日回顾等）
 * 共用本组件——默认折叠原文，用户主动展开才显示（一次点击，不打断流）。
 *
 * 两档强度：
 * - strict：严判据 contains_executable_command 命中，红色警示「含可执行命令」；
 * - broad：宽判据 fold 命中（远程端点 / 命令形态代码 / 编码块 / 不透明 token），
 *   中性提示「含端点/代码形态内容」——可能只是技术备忘，但原文一律默认折叠。
 * 这是用户自己的笔记：不删除、不改写，只避免「不带警示地把原文推到眼前」。
 */
export type FoldLevel = "strict" | "broad"

export function ExecGuardBadge({ level = "strict" }: { level?: FoldLevel }) {
  if (level === "broad") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Code2 className="size-3" />
        含端点/代码形态内容
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
  FoldLevel,
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
  const copy = COPY[level]
  const Icon = level === "broad" ? Code2 : TriangleAlert
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
    <div className="min-w-0 flex-1" data-fold-level={level}>
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
  )
}
