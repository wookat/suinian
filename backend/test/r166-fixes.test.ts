import { describe, it, expect } from "vitest";
import { app } from "../src/index";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// AI_MODEL=mock makes aiProbe answer without network: { ok, provider: "mock", model: "mock" }
const env = { AI_MODEL: "mock", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", ADMIN_TOKEN: "adm-secret" };

describe("GET /health?probe=ai admin gating (R166 P2-5)", () => {
  it("hides provider/model from unauthenticated callers", async () => {
    const res = await app.request(new Request("http://x/health?probe=ai"), undefined, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ai: Record<string, unknown> };
    // degraded 是布尔可观测位（R262 P2-8），不泄露 provider/model 配置指纹
    expect(body.ai).toEqual({ ok: true, degraded: false });
  });

  it("hides provider/model from a wrong bearer token", async () => {
    const res = await app.request(
      new Request("http://x/health?probe=ai", { headers: { authorization: "Bearer nope" } }),
      undefined,
      env,
      ctx
    );
    const body = (await res.json()) as { ai: Record<string, unknown> };
    // degraded 是布尔可观测位（R262 P2-8），不泄露 provider/model 配置指纹
    expect(body.ai).toEqual({ ok: true, degraded: false });
  });

  it("returns full metadata for ADMIN_TOKEN", async () => {
    const res = await app.request(
      new Request("http://x/health?probe=ai", { headers: { authorization: "Bearer adm-secret" } }),
      undefined,
      env,
      ctx
    );
    const body = (await res.json()) as { ai: { ok: boolean; provider: string; model: string } };
    expect(body.ai).toEqual({ ok: true, provider: "mock", model: "mock", degraded: false });
  });

  it("never exposes metadata when ADMIN_TOKEN is unset", async () => {
    const res = await app.request(
      new Request("http://x/health?probe=ai", { headers: { authorization: "Bearer " } }),
      undefined,
      { ...env, ADMIN_TOKEN: "" },
      ctx
    );
    const body = (await res.json()) as { ai: Record<string, unknown> };
    // degraded 是布尔可观测位（R262 P2-8），不泄露 provider/model 配置指纹
    expect(body.ai).toEqual({ ok: true, degraded: false });
  });
});
