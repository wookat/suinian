import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, m } from "motion/react"
import { ArrowLeft, Clock, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { NoteListSkeleton } from "@/components/ui/skeleton"
import { NoteCard } from "@/components/note-card"
import { EmptyState } from "@/components/empty-state"
import { emptyTrash, getTrash, purgeNotes, restoreNotes, ApiError, NetworkError } from "@/lib/api"
import { clearStoredPendingUndo, prunePendingUndoIds } from "@/lib/pending-undo"
import { useSettingsVersion } from "@/lib/settings"
import type { TrashNote } from "@/lib/types"

/** 剩余保留时间的人话文案（天数向上取整，刚删除即显示完整保留天数；不足一天按小时，最少「不足 1 小时」） */
export function remainingLabel(purgeAt: string | null, now = Date.now()): string {
  if (!purgeAt) return ""
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(purgeAt) ? `${purgeAt.replace(" ", "T")}Z` : purgeAt
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "即将清理"
  const days = Math.ceil(ms / 86_400_000)
  if (days > 1) return `剩 ${days} 天`
  const hours = Math.floor(ms / 3_600_000)
  return hours >= 1 ? `剩 ${hours} 小时` : "剩不足 1 小时"
}

export function TrashPage() {
  const [notes, setNotes] = useState<TrashNote[]>([])
  const [retentionDays, setRetentionDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [emptying, setEmptying] = useState(false)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const settingsVersion = useSettingsVersion()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getTrash()
      setNotes(res.notes)
      setRetentionDays(res.retention_days)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403))
        setError("未连接或 token 失效，请到设置页检查连接")
      else if (e instanceof NetworkError) setError("网络连接失败，请检查网络或 API 地址")
      else setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, settingsVersion])

  const withBusy = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyIds((s) => new Set(s).add(id))
    try {
      await fn()
    } finally {
      setBusyIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }, [])

  const handleRestore = useCallback(
    (note: TrashNote) =>
      void withBusy(note.id, async () => {
        try {
          const restored = await restoreNotes([note.id])
          prunePendingUndoIds([note.id])
          setNotes((ns) => ns.filter((n) => n.id !== note.id))
          setMsg(restored > 0 ? "已恢复 1 条笔记" : "恢复失败：笔记可能已被清理")
        } catch (e) {
          setMsg(e instanceof Error ? e.message : "恢复失败")
        }
      }),
    [withBusy],
  )

  const handlePurge = useCallback(
    (note: TrashNote) =>
      void withBusy(note.id, async () => {
        try {
          await purgeNotes([note.id])
          prunePendingUndoIds([note.id])
          setNotes((ns) => ns.filter((n) => n.id !== note.id))
          setMsg("已彻底删除 1 条笔记")
        } catch (e) {
          setMsg(e instanceof Error ? e.message : "彻底删除失败")
        }
      }),
    [withBusy],
  )

  const handleEmpty = useCallback(async () => {
    setEmptying(true)
    try {
      const purged = await emptyTrash()
      clearStoredPendingUndo()
      setNotes([])
      setMsg(`已清空最近删除（彻底删除 ${purged} 条）`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "清空失败")
    } finally {
      setEmptying(false)
    }
  }, [])

  const purgeTarget = confirmPurgeId ? notes.find((n) => n.id === confirmPurgeId) : undefined

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => (window.location.hash = "#/settings")}>
          <ArrowLeft className="size-4" /> 返回设置
        </Button>
        {notes.length > 0 && (
          <Button variant="outline" size="sm" disabled={emptying} onClick={() => setConfirmEmpty(true)}>
            {emptying ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} 全部彻底删除
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmEmpty}
        title="确认清空？不可恢复"
        description={`将彻底删除最近删除中的 ${notes.length} 条笔记，清空后无法找回。`}
        confirmLabel="确认清空"
        onConfirm={() => {
          setConfirmEmpty(false)
          void handleEmpty()
        }}
        onCancel={() => setConfirmEmpty(false)}
      />

      <ConfirmDialog
        open={purgeTarget !== undefined}
        title="彻底删除这条笔记？"
        description="彻底删除后无法恢复。"
        confirmLabel="确认彻底删除"
        onConfirm={() => {
          if (purgeTarget) handlePurge(purgeTarget)
          setConfirmPurgeId(null)
        }}
        onCancel={() => setConfirmPurgeId(null)}
      />

      <p className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <Clock className="mt-0.5 size-3.5 shrink-0" />
        删除的笔记会在这里保留 {retentionDays} 天，到期自动彻底清理；也可以随时恢复或立即彻底删除。
      </p>

      {msg && (
        <p role="status" className="text-sm text-muted-foreground">
          {msg}
        </p>
      )}

      {loading ? (
        <NoteListSkeleton />
      ) : error ? (
        <EmptyState icon={Trash2} title="加载最近删除失败" description={error} actionLabel="重试" onAction={() => void load()} />
      ) : notes.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="最近删除是空的"
          description="这里暂时没有已删除的笔记。"
        />
      ) : (
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {notes.map((note) => {
              const busy = busyIds.has(note.id)
              const remaining = remainingLabel(note.purge_at)
              return (
                <m.div
                  key={note.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                >
                  <Card className="overflow-hidden" data-testid="trash-item">
                    <div className="p-2">
                      <NoteCard note={note} className="border-0 bg-transparent shadow-none" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-3 py-2">
                      {remaining && (
                        <Badge variant={remaining === "即将清理" ? "destructive" : "outline"} className="mr-auto">
                          <Clock /> {remaining}
                        </Badge>
                      )}
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => handleRestore(note)}>
                        {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                        onClick={() => setConfirmPurgeId(note.id)}
                      >
                        <Trash2 className="size-4" /> 彻底删除
                      </Button>
                    </div>
                  </Card>
                </m.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
