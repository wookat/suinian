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

/**
 * Model-agnostic chat completion. `AI_MODEL` selects the backend:
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
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("chatComplete: failed", err);
    return null;
  }
}
