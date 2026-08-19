import type { BridgeConfig } from './config.js'
import type { AskPayload, IngestPayload, MediaIngestPayload } from './payload.js'

export interface IngestResponse {
  ok: boolean
  note_id?: string
  /** 后端生成的确认文案，如「已存：想法 #创业 #AI」 */
  reply?: string
  error?: string
}

export interface MediaIngestResponse {
  note?: { id: string }
  /** 提取/转写出的文字 */
  text?: string
  transcribed?: boolean
  /** 后端生成的确认文案，如「已记录（语音转写）：…」 */
  reply?: string
  error?: string
}

export interface AskResponse {
  /** 后端 /api/ask 成功响应不带 ok 字段，缺省视为成功 */
  ok?: boolean
  answer?: string
  references?: { index: number; note_id: string }[]
  error?: string
}

export interface TodayReviewResponse {
  date: string
  items: {
    id: string
    kind: 'year_ago' | 'month_ago' | 'revisit' | 'recurring_theme' | 'pending_todo'
    kind_label: string
    comment: string | null
    note: { id: string; title: string | null; content: string; created_at: string; tags?: string[] }
  }[]
}

export interface PreferencesResponse {
  daily_review_push: boolean
  todo_reminder_push: boolean
}

export interface TodayTodosResponse {
  date: string
  items: {
    id: string
    title: string | null
    content: string
    todo_due: string | null
    overdue: boolean
  }[]
}

/** 后端 HTTP 客户端：Bearer 鉴权 + 超时 + 指数退避重试 */
export class SuinianClient {
  constructor(
    private readonly cfg: Pick<BridgeConfig, 'apiUrl' | 'token' | 'bridgeToken' | 'requestTimeoutMs' | 'maxRetries'>
  ) {}

  ingest(payload: IngestPayload): Promise<IngestResponse> {
    return this.post<IngestResponse>('/api/ingest/wechat', payload)
  }

  /** 今日回顾（每日推送用） */
  reviewToday(): Promise<TodayReviewResponse> {
    return this.request<TodayReviewResponse>('GET', '/api/review/today')
  }

  /** 推送偏好（每日回顾 / 待办提醒开关） */
  preferences(): Promise<PreferencesResponse> {
    return this.request<PreferencesResponse>('GET', '/api/preferences')
  }

  /** 当天到期 + 已过期的未完成待办（上午推送用） */
  todosToday(): Promise<TodayTodosResponse> {
    return this.request<TodayTodosResponse>('GET', '/api/todos/today')
  }

  ask(payload: AskPayload): Promise<AskResponse> {
    return this.post<AskResponse>('/api/ask', payload)
  }

  ingestMedia(payload: MediaIngestPayload): Promise<MediaIngestResponse> {
    return this.post<MediaIngestResponse>('/api/ingest/media', payload)
  }

  /** 上报桥接状态心跳，供 /health?probe=bridge 如实暴露登录状态。
   * 心跳写的是全局共享状态，后端只认专用 BRIDGE_TOKEN（R194 P2-5）。 */
  heartbeat(status: 'starting' | 'waiting_scan' | 'online', detail?: string): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>(
      '/api/bridge/heartbeat',
      { status, ...(detail ? { detail } : {}) },
      this.cfg.bridgeToken
    )
  }

  private post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>('POST', path, body, token)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.cfg.apiUrl}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token ?? this.cfg.token}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
        })
        if (res.status === 401 || res.status === 403) {
          throw new FatalApiError(`后端鉴权失败（${res.status}），请检查 SUINIAN_TOKEN`)
        }
        if (!res.ok) throw new Error(`后端返回 ${res.status}: ${await safeText(res)}`)
        return (await res.json()) as T
      } catch (err) {
        if (err instanceof FatalApiError) throw err
        lastErr = err
        if (attempt < this.cfg.maxRetries) {
          await sleep(500 * 2 ** attempt)
        }
      }
    }
    throw lastErr
  }
}

export class FatalApiError extends Error {}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
