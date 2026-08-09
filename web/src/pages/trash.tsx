import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { NoteCard } from "@/components/note-card"
import { EmptyState } from "@/components/empty-state"
import { emptyTrash, getTrash, purgeNotes, restoreNotes, ApiError, NetworkError } from "@/lib/api"
import { useSettingsVersion } from "@/lib/settings"
import type { TrashNote } from "@/lib/types"

/** 剩余保留时间的人话文案（不足一天按小时，最少「不足 1 小时」） */
export function remainingLabel(purgeAt: string | null, now = Date.now()): string {
  if (!purgeAt) return ""
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(purgeAt) ? `${purgeAt.replace(" ", "T")}Z` : purgeAt
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ""
  if (ms <= 0) return "即将清理"
  const days = Math.floor(ms / 86_400_000)
  if (days >= 1) return `剩 ${days} 天`
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
      setNotes([])
      setMsg(`已清空回收站（彻底删除 ${purged} 条）`)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "清空失败")
    } finally {
      setEmptying(false)
    }
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => (window.location.hash = "#/settings")}>
          <ArrowLeft className="size-4" /> 返回设置
        </Button>
        {notes.length > 0 &&
          (confirmEmpty ? (
            <span className="flex items-center gap-2 text-sm">
              确认清空？不可恢复
              <Button variant="destructive" size="sm" disabled={emptying} onClick={() => void handleEmpty()}>
                {emptying ? <Loader2 className="size-4 animate-spin" /> : "确认清空"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmEmpty(false)}>
                取消
              </Button>
            </span>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmEmpty(true)}>
              <Trash2 className="size-4" /> 清空回收站
            </Button>
          ))}
      </div>

      <p className="text-xs text-muted-foreground">
        删除的笔记会在这里保留 {retentionDays} 天，到期自动彻底清理；也可以随时恢复或立即彻底删除。
      </p>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      {loading ? (
        <div className="flex justify-center py-16 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : error ? (
        <EmptyState icon={Trash2} title="加载最近删除失败" description={error} actionLabel="重试" onAction={() => void load()} />
      ) : notes.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="回收站是空的"
          description={`删除的笔记会在这里保留 ${retentionDays} 天，期间可以随时恢复。`}
        />
      ) : (
        <div className="space-y-3">
          {notes.map((note) => {
            const busy = busyIds.has(note.id)
            return (
              <Card key={note.id} className="space-y-2 p-3" data-testid="trash-item">
                <NoteCard note={note} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-auto text-xs text-muted-foreground">{remainingLabel(note.purge_at)}</span>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => handleRestore(note)}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                    恢复
                  </Button>
                  {confirmPurgeId === note.id ? (
                    <>
                      <Button variant="destructive" size="sm" disabled={busy} onClick={() => handlePurge(note)}>
                        确认彻底删除
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirmPurgeId(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmPurgeId(note.id)}>
                      <Trash2 className="size-4" /> 彻底删除
                    </Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
