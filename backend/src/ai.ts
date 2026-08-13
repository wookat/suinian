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
 * Default fallback when the primary provider fails (network error, timeout,
 * 4xx/5xx incl. insufficient balance). Workers AI runs on the account's own
 * binding, so it stays available even when every external key is dead.
 * Override with AI_FALLBACK_MODEL; set it to "none" to disable the chain.
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
  try {
    const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
    })) as { response?: string; choices?: { message?: { content?: string } }[] };
    return out.choices?.[0]?.message?.content ?? out.response ?? null;
  } catch (err) {
    console.error("chatComplete: workers-ai failed", model, err);
    return null;
  }
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
 * Model-agnostic chat completion with a degradation chain. `AI_MODEL` selects
 * the primary backend:
 * - `mock` returns deterministic offline responses (local dev, no key needed)
 * - `workers-ai:<model>` runs on the Workers AI binding (`env.AI`)
 * - anything else goes to the OpenAI-compatible endpoint at
 *   `AI_BASE_URL || DEEPSEEK_BASE_URL` with `DEEPSEEK_API_KEY`.
 * When the primary fails (balance exhausted, outage, timeout) the call falls
 * back to `AI_FALLBACK_MODEL` (default: Workers AI llama-3.3-70b). The primary
 * is always tried first, so service reverts automatically once it recovers.
 * Returns the assistant message content, or null when every provider failed.
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

/**
 * Lightweight liveness probe for /health?probe=ai: one tiny completion against
 * the primary, then the fallback. Reports which layer answered so external
 * monitoring can alert on both "AI down" and "running degraded".
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
