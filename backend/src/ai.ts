import type { Env } from "./types";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /** HTTP timeout in ms for remote providers (default 20s, keeps waitUntil tasks within limits). */
  timeout_ms?: number;
};

const WORKERS_AI_PREFIX = "workers-ai:";
const MOCK_MODEL = "mock";

/**
 * Race a promise against a timeout; rejects with an Error on expiry. The
 * canonical guard for every Workers AI binding call (`env.AI.run` has no
 * abort signal and can hang indefinitely on cold starts), shared by all
 * AI call sites so no provider path runs unbounded.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Second layer of the provider chain, used when the configured primary
 * (external OpenAI-compatible API) fails: network error, timeout, 4xx/5xx
 * incl. insufficient balance. Workers AI runs on the account's own binding,
 * so it stays available even when every external key is dead — it is the
 * service baseline, not a degraded mode (R134: production has run on it
 * long-term with full quality on discriminative tasks). Override with
 * AI_FALLBACK_MODEL; set it to "none" to disable the chain.
 */
const DEFAULT_FALLBACK_MODEL = "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type AiEnv = Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL" | "AI_FALLBACK_MODEL">;

/**
 * Deterministic offline responses for local development (`AI_MODEL=mock`):
 * prompts that demand strict JSON (triage/graph) get a minimal valid JSON
 * object, everything else gets a canned text answer. Lets `wrangler dev` run
 * the full note pipeline with no API key.
 */
function mockChatResponse(opts: ChatOptions): string {
  const system = opts.messages.find((m) => m.role === "system")?.content ?? "";
  if (system.includes("严格 JSON") || system.includes("strict JSON")) {
    return JSON.stringify({
      category: "idea",
      tags: ["本地开发"],
      title: "",
      is_sensitive: false,
      todo_due: null,
      amount: null,
      currency: null,
      merchant: null,
      entities: [],
      relations: [],
    });
  }
  return "（本地 mock AI 回复：未配置真实模型，设置 DEEPSEEK_API_KEY 或 AI_MODEL 后可获得真实回答。）";
}

async function runWorkersAi(env: AiEnv, model: string, opts: ChatOptions): Promise<string | null> {
  if (!env.AI) return null;
  // same retry policy as the fetch path: transient failures get one retry,
  // timeouts don't (a second slow attempt would double the latency)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = (await withTimeout(
        env.AI.run(model as Parameters<Ai["run"]>[0], {
          messages: opts.messages,
          temperature: opts.temperature,
          max_tokens: opts.max_tokens,
        }) as Promise<{ response?: unknown; choices?: { message?: { content?: unknown } }[] }>,
        opts.timeout_ms ?? 20_000,
        `workers-ai ${model}`
      )) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
      const content = out.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      // `response` is not always a string (see extractWorkersAiDelta): only
      // trust it after a type check, never stringify structured values
      return typeof out.response === "string" ? out.response : null;
    } catch (err) {
      console.error("chatComplete: workers-ai failed", model, err);
      const timedOut = err instanceof Error && err.message.includes("timed out");
      if (attempt === 0 && !timedOut) continue;
      return null;
    }
  }
  return null;
}

async function runOpenAiCompat(env: AiEnv, model: string, opts: ChatOptions): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  // transient provider failures (429/5xx, network errors) get one retry;
  // timeouts don't retry — a second slow attempt would double the latency
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.AI_BASE_URL || env.DEEPSEEK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model,
          temperature: opts.temperature,
          max_tokens: opts.max_tokens,
          messages: opts.messages,
        }),
        signal: AbortSignal.timeout(opts.timeout_ms ?? 20_000),
      });
      if (!res.ok) {
        console.error("chatComplete: provider error", res.status, (await res.text()).slice(0, 200));
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
        return null;
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      console.error("chatComplete: failed", err);
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      if (attempt === 0 && !timedOut) continue;
      return null;
    }
  }
  return null;
}

function runModel(env: AiEnv, model: string, opts: ChatOptions): Promise<string | null> {
  if (model.startsWith(WORKERS_AI_PREFIX)) return runWorkersAi(env, model.slice(WORKERS_AI_PREFIX.length), opts);
  return runOpenAiCompat(env, model, opts);
}

/** Resolve the fallback model for `primary`, or null when the chain is disabled/degenerate. */
function fallbackModelFor(env: AiEnv, primary: string): string | null {
  const fb = (env.AI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL).trim();
  if (!fb || fb === "none" || fb === MOCK_MODEL || fb === primary) return null;
  return fb;
}

/**
 * Model-agnostic chat completion with a two-layer provider chain. `AI_MODEL`
 * selects the first layer:
 * - `mock` returns deterministic offline responses (local dev, no key needed)
 * - `workers-ai:<model>` runs on the Workers AI binding (`env.AI`)
 * - anything else goes to the OpenAI-compatible endpoint at
 *   `AI_BASE_URL || DEEPSEEK_BASE_URL` with `DEEPSEEK_API_KEY`.
 * When the first layer fails (balance exhausted, outage, timeout) the call
 * moves to `AI_FALLBACK_MODEL` (default: Workers AI llama-3.3-70b, the
 * service baseline). The first layer is always tried first, so service
 * reverts automatically once it recovers — running on Workers AI is normal
 * operation, not an outage. Returns the assistant message content, or null
 * when every provider failed.
 */
export async function chatComplete(env: AiEnv, opts: ChatOptions): Promise<string | null> {
  const model = env.AI_MODEL || "deepseek-chat";
  if (model === MOCK_MODEL) return mockChatResponse(opts);
  const primary = await runModel(env, model, opts);
  if (primary !== null) return primary;
  const fallback = fallbackModelFor(env, model);
  if (!fallback) return null;
  console.error(`chatComplete: primary ${model} failed, falling back to ${fallback}`);
  return runModel(env, fallback, opts);
}

/** Parse one provider SSE body, feeding text chunks to onDelta; returns full text or null. */
async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  extract: (data: string) => string | null,
  onDelta: (text: string) => void
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let sawAny = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const text = extract(data);
        // extractors are typed to return string|null, but provider payloads are
        // untrusted: drop any non-string that slips through instead of
        // stringifying it into the answer
        if (typeof text === "string" && text) {
          sawAny = true;
          full += text;
          onDelta(text);
        }
      }
    }
  } catch (err) {
    // a stream that dies after emitting text is not retried (the client
    // already rendered it); only a stream that died before any text falls
    // through the provider chain
    console.error("chatCompleteStream: stream interrupted", err);
  }
  return sawAny ? full : null;
}

const extractOpenAiDelta = (data: string): string | null => {
  try {
    const j = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
};

// Workers AI 流帧同时带 OpenAI 兼容的 choices[0].delta.content（始终是字符串）
// 和自有的 response 字段；后者对形如 `[3]` 的角标 token 会序列化成未加引号的
// JSON 数组（R175 P1-1：被字符串化成 `3`，括号丢失导致引用对账漏配）。
// 优先读 canonical 的 delta.content，response 仅在确为字符串时兜底。
const extractWorkersAiDelta = (data: string): string | null => {
  try {
    const j = JSON.parse(data) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
    const content = j.choices?.[0]?.delta?.content;
    if (typeof content === "string") return content;
    if (typeof j.response === "string") return j.response;
    if (j.response !== undefined && j.response !== null) {
      console.error("extractWorkersAiDelta: dropping non-string response frame", JSON.stringify(j.response).slice(0, 80));
    }
    return null;
  } catch {
    return null;
  }
};

async function runWorkersAiStream(env: AiEnv, model: string, opts: ChatOptions, onDelta: (t: string) => void): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const stream = (await withTimeout(
      env.AI.run(model as Parameters<Ai["run"]>[0], {
        messages: opts.messages,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        stream: true,
      }) as unknown as Promise<ReadableStream<Uint8Array>>,
      opts.timeout_ms ?? 20_000,
      `workers-ai stream ${model}`
    )) as ReadableStream<Uint8Array>;
    return await consumeSseBody(stream, extractWorkersAiDelta, onDelta);
  } catch (err) {
    console.error("chatCompleteStream: workers-ai failed", model, err);
    return null;
  }
}

async function runOpenAiCompatStream(env: AiEnv, model: string, opts: ChatOptions, onDelta: (t: string) => void): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  try {
    const res = await fetch(`${env.AI_BASE_URL || env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        messages: opts.messages,
        stream: true,
      }),
      signal: AbortSignal.timeout(opts.timeout_ms ?? 20_000),
    });
    if (!res.ok || !res.body) {
      console.error("chatCompleteStream: provider error", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    return await consumeSseBody(res.body, extractOpenAiDelta, onDelta);
  } catch (err) {
    console.error("chatCompleteStream: failed", err);
    return null;
  }
}

function runModelStream(env: AiEnv, model: string, opts: ChatOptions, onDelta: (t: string) => void): Promise<string | null> {
  if (model.startsWith(WORKERS_AI_PREFIX)) return runWorkersAiStream(env, model.slice(WORKERS_AI_PREFIX.length), opts, onDelta);
  return runOpenAiCompatStream(env, model, opts, onDelta);
}

/**
 * Streaming variant of `chatComplete`: feeds incremental text to `onDelta` as
 * the model produces it and resolves with the full text (same provider chain
 * and fallback semantics). If the stream dies after some text already went
 * out, the accumulated text is returned rather than retried — the caller's
 * final reconcile pass owns the definitive answer. Providers that failed
 * before emitting anything fall through the chain; a chain layer that only
 * supports non-streaming still works (single onDelta with the whole text).
 */
export async function chatCompleteStream(env: AiEnv, opts: ChatOptions, onDelta: (text: string) => void): Promise<string | null> {
  const model = env.AI_MODEL || "deepseek-chat";
  if (model === MOCK_MODEL) {
    const text = mockChatResponse(opts);
    onDelta(text);
    return text;
  }
  const primary = await runModelStream(env, model, opts, onDelta);
  if (primary !== null) return primary;
  const fallback = fallbackModelFor(env, model);
  if (!fallback) return null;
  console.error(`chatCompleteStream: primary ${model} failed, falling back to ${fallback}`);
  return runModelStream(env, fallback, opts, onDelta);
}

/**
 * Lightweight liveness probe for /health?probe=ai: one tiny completion against
 * the first chain layer, then the second. `provider` reports which layer
 * answered (chain position, not service quality): "fallback" means Workers AI
 * — the normal baseline while no external key is funded — so external
 * monitoring should alert on `ok:false` only, and may separately watch
 * `provider` to observe cutovers (e.g. DeepSeek recovering).
 */
export async function aiProbe(env: AiEnv): Promise<{ ok: boolean; provider: "primary" | "fallback" | "mock" | null; model: string | null }> {
  const model = env.AI_MODEL || "deepseek-chat";
  if (model === MOCK_MODEL) return { ok: true, provider: "mock", model };
  const opts: ChatOptions = {
    max_tokens: 8,
    temperature: 0,
    timeout_ms: 8_000,
    messages: [{ role: "user", content: "reply with: ok" }],
  };
  if ((await runModel(env, model, opts)) !== null) return { ok: true, provider: "primary", model };
  const fallback = fallbackModelFor(env, model);
  if (fallback && (await runModel(env, fallback, opts)) !== null) return { ok: true, provider: "fallback", model: fallback };
  return { ok: false, provider: null, model: null };
}
