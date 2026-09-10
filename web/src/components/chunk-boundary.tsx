import { Component, Fragment, type ErrorInfo, type ReactNode } from "react"
import { isChunkLoadError } from "@/lib/lazy-retry"

type BoundaryProps = {
  children: ReactNode
  /** 出错后渲染什么；拿到 `retry` 可重新挂载子树（分包错误会重新发起下载） */
  fallback: (info: { error: unknown; chunk: boolean; retry: () => void }) => ReactNode
  /** 变化时自动清除错误态（例如路由切换） */
  resetKey?: unknown
}
type BoundaryState = { caught: { error: unknown } | null; generation: number }

/**
 * 渲染期错误边界。没有它时任何一个懒加载分包失败都会让 React 卸载整个根节点，
 * 用户只剩一屏骨架且回到在线也不会恢复。`retry` 通过换 key 重新挂载子树。
 */
export class ChunkBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { caught: null, generation: 0 }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { caught: { error } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("ChunkBoundary caught", error, info.componentStack)
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.caught) this.retry()
  }

  retry = () => {
    this.setState((s) => ({ caught: null, generation: s.generation + 1 }))
  }

  render() {
    const { caught } = this.state
    if (caught) return this.props.fallback({ error: caught.error, chunk: isChunkLoadError(caught.error), retry: this.retry })
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>
  }
}
