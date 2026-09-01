import { useState, type ReactNode } from "react"
import { Eye, EyeOff, TriangleAlert } from "lucide-react"

/**
 * 可执行载荷折叠警示（R304 P0-A）：服务端在笔记数据上给出
 * contains_executable_command 标记，所有展示笔记原文的出口（时间流卡片、
 * 问答引用卡片、搜索结果、今日回顾等）共用本组件——默认折叠原文并给出
 * 明确风险提示，用户主动展开才显示。这是用户自己的笔记：不删除、不改写，
 * 只避免「不带警示地把可执行命令推到眼前」。
 */
export function ExecGuardBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
      <TriangleAlert className="size-3" />
      含可执行命令
    </span>
  )
}

export function ExecGuard({
  children,
  compact = false,
}: {
  children: ReactNode
  /** 紧凑模式（回顾卡等小空间）：提示文案缩短 */
  compact?: boolean
}) {
  const [revealed, setRevealed] = useState(false)
  if (!revealed) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation()
          setRevealed(true)
        }}
        className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-left"
      >
        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 text-xs font-medium text-red-700 dark:text-red-400">
          <TriangleAlert className="size-3" /> 含可执行命令，已折叠
        </span>
        <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-secondary px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <Eye className="size-3" /> 展开查看
        </span>
        {!compact && (
          <span className="w-full text-xs leading-relaxed text-muted-foreground">
            这条笔记包含可执行命令或危险指令（如下载执行远程代码）。内容未被修改，展开即可查看；请勿直接复制执行。
          </span>
        )}
      </button>
    )
  }
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-red-700 dark:text-red-400">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        含可执行命令，请勿直接复制执行
      </p>
      {children}
      <button
        onClick={(e) => {
          e.stopPropagation()
          setRevealed(false)
        }}
        className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <EyeOff className="size-3" /> 收起
      </button>
    </div>
  )
}
