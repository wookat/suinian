import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/** 应用内确认弹窗：替代原生 window.confirm，与账号注销等危险操作口径一致。
 *  基于 Radix AlertDialog：role="alertdialog"、焦点陷阱、Esc / 点遮罩 = 取消，
 *  确认按钮为破坏性样式且默认聚焦。宿主卡片可能带 onClick（多选模式），
 *  Portal 内的合成事件仍沿 React 树冒泡，这里统一截断。 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确定",
  confirmVariant = "destructive",
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  confirmVariant?: "default" | "destructive"
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="contents"
      onClick={(e) => {
        e.stopPropagation()
        if ((e.target as HTMLElement).dataset.slot === "alert-dialog-overlay") onCancel()
      }}
    >
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onCancel()
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            // 延后聚焦，确保触发弹窗的那次 Enter（keydown→keypress）不会落到确认键上
            const content = e.currentTarget as HTMLElement | null
            window.setTimeout(() => content?.querySelector<HTMLElement>("[data-confirm]")?.focus(), 0)
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription className={description ? undefined : "sr-only"}>
              {description ?? title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancel}>取消</AlertDialogCancel>
            <AlertDialogAction data-confirm variant={confirmVariant} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
