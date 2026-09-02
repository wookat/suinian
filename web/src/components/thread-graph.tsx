import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force"
import { Maximize2, RotateCcw } from "lucide-react"
import { cn, noteDisplayLabel } from "@/lib/utils"
import type { Note, ThreadGraph } from "@/lib/types"

const MAX_ENTITIES = 20
const MAX_NOTES = 30

const ENTITY_COLOR: Record<string, string> = {
  person: "var(--color-graph-person)",
  product: "var(--color-graph-product)",
  project: "var(--color-graph-project)",
  org: "var(--color-graph-org)",
  place: "var(--color-graph-place)",
  concept: "var(--color-graph-concept)",
  other: "var(--color-graph-other)",
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  person: "人物",
  product: "产品",
  project: "项目",
  org: "组织",
  place: "地点",
  concept: "概念",
  other: "其他",
}

interface GraphNode extends SimulationNodeDatum {
  id: string
  kind: "entity" | "note"
  label: string
  type?: string
  radius: number
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  kind: "relation" | "mention"
  label?: string
}

interface ThreadGraphViewProps {
  graph: ThreadGraph
  notes: Note[]
  highlightedNoteIds: Set<string>
  onHighlightNotes: (noteIds: string[]) => void
  onJumpToNote: (noteId: string) => void
}

function noteLabel(n: Note): string {
  if (n.is_sensitive === 1) return "敏感内容"
  const t = noteDisplayLabel(n, Infinity)
  return t.length > 14 ? `${t.slice(0, 14)}…` : t || "碎片"
}

export function ThreadGraphView({
  graph,
  notes,
  highlightedNoteIds,
  onHighlightNotes,
  onJumpToNote,
}: ThreadGraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 600, h: 320 })
  const [tick, setTick] = useState(0)
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null)

  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])

  const { nodes, links } = useMemo(() => {
    const entities = graph.entities.slice(0, MAX_ENTITIES)
    const entityIds = new Set(entities.map((e) => e.id))
    const mentions = (graph.mentions ?? []).filter((m) => entityIds.has(m.entity_id) && noteById.has(m.note_id))
    const mentionedNoteIds: string[] = []
    for (const m of mentions) {
      if (!mentionedNoteIds.includes(m.note_id)) mentionedNoteIds.push(m.note_id)
    }
    const noteIds = new Set(mentionedNoteIds.slice(0, MAX_NOTES))
    const maxCount = Math.max(1, ...entities.map((e) => e.note_count))
    const nodes: GraphNode[] = [
      ...entities.map((e) => ({
        id: e.id,
        kind: "entity" as const,
        label: e.name,
        type: e.type,
        radius: 10 + 8 * Math.sqrt(e.note_count / maxCount),
      })),
      ...[...noteIds].map((id) => ({
        id,
        kind: "note" as const,
        label: noteLabel(noteById.get(id)!),
        radius: 5,
      })),
    ]
    const nodeIds = new Set(nodes.map((n) => n.id))
    const links: GraphLink[] = [
      ...graph.relations
        .filter((r) => nodeIds.has(r.src_id) && nodeIds.has(r.dst_id))
        .map((r) => ({ source: r.src_id, target: r.dst_id, kind: "relation" as const, label: r.relation_label })),
      ...mentions
        .filter((m) => noteIds.has(m.note_id))
        .map((m) => ({ source: m.entity_id, target: m.note_id, kind: "mention" as const })),
    ]
    return { nodes, links }
  }, [graph, noteById])

  const simRef = useRef<ReturnType<typeof forceSimulation<GraphNode>> | null>(null)
  const userMoved = useRef(false)
  const sizeRef = useRef(size)
  sizeRef.current = size

  // Fit-to-view: center the node bounding box in the container and scale it to
  // fit, so the initial layout and "重置视图" are truly centered at any width.
  const fitView = useCallback((ns: GraphNode[]) => {
    const pts = ns.filter((n) => n.x != null && n.y != null)
    if (pts.length === 0) return
    const pad = 28
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of pts) {
      // labels render below nodes, centered; approximate their box so the fit
      // keeps them inside the container (CJK glyphs ≈ fontSize px wide each)
      const labelHalfW = (n.label.length * (n.kind === "entity" ? 12 : 10)) / 2
      minX = Math.min(minX, (n.x ?? 0) - Math.max(n.radius, labelHalfW))
      maxX = Math.max(maxX, (n.x ?? 0) + Math.max(n.radius, labelHalfW))
      minY = Math.min(minY, (n.y ?? 0) - n.radius)
      maxY = Math.max(maxY, (n.y ?? 0) + n.radius + 16)
    }
    const { w, h } = sizeRef.current
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const k = Math.min(1.5, Math.max(0.2, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)))
    setTransform({
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    })
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      if (w > 0) setSize({ w, h: Math.max(260, Math.min(400, w * 0.55)) })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let fitted = false
    const sim = forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance((l) => (l.kind === "relation" ? 90 : 50))
          .strength((l) => (l.kind === "relation" ? 0.5 : 0.3)),
      )
      .force("charge", forceManyBody().strength(-160))
      .force("center", forceCenter(size.w / 2, size.h / 2))
      .force(
        "collide",
        // 标签画在节点下方且宽于节点本体：碰撞半径按标签近似宽度取值（R150
        // P2-5），否则布局只避开圆点、标签互相压字不可读
        forceCollide<GraphNode>().radius(
          (d) => Math.max(d.radius, (d.label.length * (d.kind === "entity" ? 12 : 10)) / 2) + 14,
        ),
      )
      .on("tick", () => {
        setTick((t) => t + 1)
        // early centering as soon as the layout roughly stabilizes
        if (!fitted && !userMoved.current && sim.alpha() < 0.08) {
          fitted = true
          fitView(nodes)
        }
      })
      .on("end", () => {
        // auto-center once the layout settles, unless the user already panned/zoomed
        if (!userMoved.current) fitView(nodes)
      })
    simRef.current = sim
    return () => {
      sim.stop()
      simRef.current = null
    }
  }, [nodes, links, size.w, size.h, fitView])

  // pan / zoom / drag via pointer events (supports touch pinch)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const dragNode = useRef<GraphNode | null>(null)
  const pinchDist = useRef(0)
  const moved = useRef(false)

  const toGraph = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left - transform.x) / transform.k,
      y: (clientY - rect.top - transform.y) / transform.k,
    }
  }

  const findNode = (clientX: number, clientY: number): GraphNode | null => {
    const p = toGraph(clientX, clientY)
    for (const n of nodes) {
      const dx = (n.x ?? 0) - p.x
      const dy = (n.y ?? 0) - p.y
      if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 8) return n
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    if (pointers.current.size === 1) {
      dragNode.current = findNode(e.clientX, e.clientY)
      if (dragNode.current) {
        const p = toGraph(e.clientX, e.clientY)
        dragNode.current.fx = p.x
        dragNode.current.fy = p.y
        simRef.current?.alphaTarget(0.3).restart()
      }
    } else if (pointers.current.size === 2) {
      if (dragNode.current) {
        dragNode.current.fx = null
        dragNode.current.fy = null
        dragNode.current = null
      }
      const pts = [...pointers.current.values()]
      pinchDist.current = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 3) moved.current = true
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()]
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      if (pinchDist.current > 0) {
        userMoved.current = true
        const rect = containerRef.current!.getBoundingClientRect()
        const cx = (pts[0].x + pts[1].x) / 2 - rect.left
        const cy = (pts[0].y + pts[1].y) / 2 - rect.top
        const factor = dist / pinchDist.current
        setTransform((t) => {
          const k = Math.min(4, Math.max(0.3, t.k * factor))
          const scale = k / t.k
          return { k, x: cx - (cx - t.x) * scale, y: cy - (cy - t.y) * scale }
        })
      }
      pinchDist.current = dist
    } else if (dragNode.current) {
      const p = toGraph(e.clientX, e.clientY)
      dragNode.current.fx = p.x
      dragNode.current.fy = p.y
    } else if (pointers.current.size === 1) {
      userMoved.current = true
      setTransform((t) => ({ ...t, x: t.x + e.clientX - prev.x, y: t.y + e.clientY - prev.y }))
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (dragNode.current) {
      dragNode.current.fx = null
      dragNode.current.fy = null
      dragNode.current = null
      simRef.current?.alphaTarget(0)
    }
    if (!moved.current) {
      const node = findNode(e.clientX, e.clientY)
      if (node) handleNodeClick(node)
      else {
        setSelectedEntity(null)
        onHighlightNotes([])
      }
    }
    pinchDist.current = 0
  }

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    userMoved.current = true
    const rect = containerRef.current!.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setTransform((t) => {
      const k = Math.min(4, Math.max(0.3, t.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      const scale = k / t.k
      return { k, x: cx - (cx - t.x) * scale, y: cy - (cy - t.y) * scale }
    })
  }

  function handleNodeClick(node: GraphNode) {
    if (node.kind === "note") {
      onJumpToNote(node.id)
      return
    }
    if (selectedEntity === node.id) {
      setSelectedEntity(null)
      onHighlightNotes([])
      return
    }
    setSelectedEntity(node.id)
    const related = (graph.mentions ?? []).filter((m) => m.entity_id === node.id).map((m) => m.note_id)
    onHighlightNotes(related)
  }

  const connected = useMemo(() => {
    if (!selectedEntity) return null
    const s = new Set<string>([selectedEntity])
    for (const l of links) {
      const src = typeof l.source === "object" ? l.source.id : String(l.source)
      const dst = typeof l.target === "object" ? l.target.id : String(l.target)
      if (src === selectedEntity) s.add(dst)
      if (dst === selectedEntity) s.add(src)
    }
    return s
  }, [selectedEntity, links])

  if (nodes.length === 0) return null
  void tick

  const usedTypes = [...new Set(nodes.filter((n) => n.kind === "entity").map((n) => n.type ?? "other"))]

  return (
    <div>
      <div
        ref={containerRef}
        className="relative touch-none select-none overflow-hidden rounded-lg border bg-muted/30"
        style={{ height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <svg width={size.w} height={size.h} className="block cursor-grab active:cursor-grabbing">
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {links.map((l, i) => {
              const s = l.source as GraphNode
              const t = l.target as GraphNode
              if (s.x == null || t.x == null) return null
              const dim = connected && !(connected.has(s.id) && connected.has(t.id))
              return (
                <g key={i} opacity={dim ? 0.15 : 1}>
                  <line
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke="var(--border)"
                    strokeWidth={l.kind === "relation" ? 1.6 : 0.8}
                    strokeDasharray={l.kind === "mention" ? "3 3" : undefined}
                  />
                  {l.kind === "relation" && l.label && (
                    <text
                      x={((s.x ?? 0) + (t.x ?? 0)) / 2}
                      y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 3}
                      textAnchor="middle"
                      fontSize={10}
                      fill="var(--foreground)"
                      paintOrder="stroke"
                      stroke="var(--background)"
                      strokeWidth={3}
                      strokeLinejoin="round"
                    >
                      {l.label}
                    </text>
                  )}
                </g>
              )
            })}
            {nodes.map((n) => {
              if (n.x == null) return null
              const dim = connected && !connected.has(n.id)
              const isSelected = selectedEntity === n.id
              const isHighlightedNote = n.kind === "note" && highlightedNoteIds.has(n.id)
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.2 : 1} className="cursor-pointer">
                  <circle
                    r={n.radius}
                    fill={n.kind === "entity" ? ENTITY_COLOR[n.type ?? "other"] : "var(--card)"}
                    stroke={
                      isSelected || isHighlightedNote
                        ? "var(--ring)"
                        : n.kind === "note"
                          ? "var(--muted-foreground)"
                          : "var(--card)"
                    }
                    strokeWidth={isSelected || isHighlightedNote ? 2.5 : n.kind === "note" ? 1 : 1.5}
                  />
                  <text
                    y={n.radius + 11}
                    textAnchor="middle"
                    fontSize={n.kind === "entity" ? 12 : 10}
                    fontWeight={n.kind === "entity" ? 500 : 400}
                    fill="var(--foreground)"
                    paintOrder="stroke"
                    stroke="var(--background)"
                    strokeWidth={3}
                    strokeLinejoin="round"
                  >
                    {n.label}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
        <div className="absolute right-2 top-2 flex gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              userMoved.current = false
              fitView(nodes)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="重置视图"
            title="重置视图"
            className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              simRef.current?.alpha(0.6).restart()
            }}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="重新布局"
            title="重新布局"
            className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {usedTypes.map((t) => (
          <span key={t} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full" style={{ backgroundColor: ENTITY_COLOR[t] }} />
            {ENTITY_TYPE_LABEL[t] ?? t}
          </span>
        ))}
        {nodes.some((n) => n.kind === "note") && (
          <span className="inline-flex items-center gap-1">
            <span className={cn("size-2 rounded-full border border-muted-foreground bg-card")} />
            碎片（点击跳转）
          </span>
        )}
        <span className="ml-auto hidden sm:inline">拖拽平移 · 滚轮/双指缩放 · 点实体高亮相关碎片</span>
        <span className="ml-auto sm:hidden">点实体可高亮相关碎片</span>
      </div>
      {selectedEntity && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-accent/60 px-2.5 py-1.5 text-xs text-accent-foreground">
          <span>
            已高亮「{nodes.find((n) => n.id === selectedEntity)?.label ?? "实体"}」相关的 {highlightedNoteIds.size} 条碎片
          </span>
          <button
            onClick={() => {
              setSelectedEntity(null)
              onHighlightNotes([])
            }}
            className="shrink-0 font-medium underline-offset-2 hover:underline"
          >
            取消高亮
          </button>
        </div>
      )}
    </div>
  )
}
