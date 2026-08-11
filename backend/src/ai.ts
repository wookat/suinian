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

/**
 * Model-agnostic chat completion. `AI_MODEL` selects the backend:
 * - `mock` returns deterministic offline responses (local dev, no key needed)
 * - `workers-ai:<model>` runs on the Workers AI binding (`env.AI`)
 * - anything else goes to the OpenAI-compatible endpoint at
 *   `AI_BASE_URL || DEEPSEEK_BASE_URL` with `DEEPSEEK_API_KEY`.
 * Returns the assistant message content, or null on any failure.
 */
export async function chatComplete(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  opts: ChatOptions
): Promise<string | null> {
  const model = env.AI_MODEL || "deepseek-chat";
  if (model === MOCK_MODEL) return mockChatResponse(opts);
  // transient provider failures (429/5xx, network errors) get one retry;
  // timeouts don't retry — a second slow attempt would double the latency
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (model.startsWith(WORKERS_AI_PREFIX)) {
        if (!env.AI) return null;
        const out = (await env.AI.run(model.slice(WORKERS_AI_PREFIX.length) as Parameters<Ai["run"]>[0], {
          messages: opts.messages,
          temperature: opts.temperature,
          max_tokens: opts.max_tokens,
        })) as { response?: string; choices?: { message?: { content?: string } }[] };
        return out.choices?.[0]?.message?.content ?? out.response ?? null;
      }
      if (!env.DEEPSEEK_API_KEY) return null;
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
