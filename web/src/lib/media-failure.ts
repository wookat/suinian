import { ApiError, NetworkError } from "@/lib/api"

/**
 * 附件原件（/api/notes/:id/file）加载失败给用户看的原因。
 * 只把网络层 / 服务端状态码翻成可读文案；服务端 JSON 里的英文 error、浏览器异常原文一律不给用户（返回 null 只显示「加载失败」）。
 */
export function mediaLoadFailureText(e: unknown): string | null {
  if (e instanceof NetworkError) return e.message
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 403) return "登录已失效，请重新登录"
    if (e.status === 404) return "原件不存在或已被删除"
    if (e.status === 429) return "请求太频繁，请稍后再试"
    if (e.status >= 500) return `服务端暂时不可用（HTTP ${e.status}）`
    return `服务端拒绝了请求（HTTP ${e.status}）`
  }
  return null
}

/** 联网 / 回到前台时值得自动重拉的失败：只有连接级失败与服务端 5xx，404 / 401 重拉也不会变 */
export function mediaLoadFailureAutoRetries(e: unknown): boolean {
  if (e instanceof NetworkError) return !e.timeout
  return e instanceof ApiError && e.status >= 500
}
