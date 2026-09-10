import { lazy, type ComponentType, type LazyExoticComponent } from "react"

/** 动态分包加载失败的浏览器报错形态（Chrome / Safari / Firefox / webpack 风格）。 */
const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk .* failed/i
/** Chrome / Firefox 会把失败的分包 URL 写进报错文案。 */
const CHUNK_URL_RE = /https?:\/\/[^\s'"]+?\.m?js\b/

export function isChunkLoadError(err: unknown): boolean {
  return CHUNK_ERROR_RE.test(errorMessage(err))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : ""
}

const waitOnline = () =>
  new Promise<void>((resolve) => window.addEventListener("online", () => resolve(), { once: true }))
const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** 在线时的重试间隔；离线时不计次数、等 `online` 事件再试。 */
const RETRY_DELAYS_MS = [800, 2500]

type Options = {
  /**
   * 分包下载失败后，浏览器会把该 URL 在模块表里记成「失败」，同 URL 再 `import()` 不再发网络请求、直接再抛。
   * 叶子分包（只被这里动态引入、没有别的分包静态 import 它）可以带 `?retry=` 换个 URL 重新下载；
   * 共享分包（如 app-shell 被所有页面分包静态引用）不能这么做——会得到第二份模块实例，只能整页重载。
   */
  leaf: boolean
}

/**
 * 容错的动态 `import()`：分包下载失败（断网、切网、CDN 抖动）时——
 * 浏览器离线就先等联网再发请求，在线则短退避重试两次，仍失败才 reject。
 * `load` 是原始 `import("...")`（保留 Vite 的静态分析与预加载）。
 */
export async function importRetry<M>(load: () => Promise<M>, { leaf }: Options = { leaf: true }): Promise<M> {
  let onlineAttempt = 0
  let freshUrl: string | null = null
  for (;;) {
    // 明知离线就不发请求：失败过的 URL（含 modulepreload 的依赖）会被浏览器记成「失败」，之后只能整页重载
    if (typeof navigator !== "undefined" && navigator.onLine === false) await waitOnline()
    try {
      return freshUrl ? ((await import(/* @vite-ignore */ freshUrl)) as M) : await load()
    } catch (err) {
      if (!isChunkLoadError(err)) throw err
      if (leaf) {
        const url = CHUNK_URL_RE.exec(errorMessage(err))?.[0]
        if (url) freshUrl = `${url}?retry=${Date.now().toString(36)}`
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) continue
      if (onlineAttempt >= RETRY_DELAYS_MS.length) throw err
      await sleep(RETRY_DELAYS_MS[onlineAttempt++])
    }
  }
}

/**
 * `React.lazy` 的容错版：分包加载走 `importRetry`，仍失败才抛给外层 `ChunkBoundary`（components/chunk-boundary）。
 * `React.lazy` 对已拒绝的 thenable 是永久缓存的，所以重试必须发生在这里、在 reject 之前。
 * `pick` 从模块里取出组件。
 */
// 泛型约束照抄 React.lazy 的签名（组件 props 由调用方类型决定，这里不能收窄）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyRetry<M, T extends ComponentType<any>>(
  load: () => Promise<M>,
  pick: (mod: M) => T,
  options: Options = { leaf: true },
): LazyExoticComponent<T> {
  return lazy<T>(async () => ({ default: pick(await importRetry(load, options)) }))
}
