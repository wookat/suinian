import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { chatComplete, chatCompleteStream, aiProbe, primaryBreakerState, resetPrimaryBreaker } from "../src/ai";

// R338：主模型熔断——生产 tail 实录（swe-1.7 中转）每个故障窗口内 /api/ask 逐条等满 20s 超时再回落；
// 熔断后同隔离实例在窗口内直走 fallback，窗口到期半开重试，主模型任一成功即闭合。

const OPTS = { messages: [{ role: "user" as const, content: "hi" }] };
const ENV = { DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.example.test" };

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
const timeoutErr = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const timingOut = () =>
  vi.fn<() => Promise<Response>>(async () => {
    throw timeoutErr();
  });
const status = (code: number) => new Response(JSON.stringify({ error: { message: `status ${code}` } }), { status: code });
const sseBody = (chunks: string[]) =>
  new Response(chunks.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`).join("") + "data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

function makeAi(response: string) {
  return {
    run: vi.fn(async (_model: string, input: { stream?: boolean }) =>
      input.stream
        ? new Response(`data: ${JSON.stringify({ response })}\n`).body
        : { response }
    ),
  } as unknown as Ai;
}

beforeEach(() => resetPrimaryBreaker());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("R338 primary breaker (chatComplete)", () => {
  it("一次超时后窗口内直走 fallback，不再请求主模型；窗口到期半开重试，成功即闭合", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");

    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(primaryBreakerState()).toMatchObject({ open: true, trips: 1 });

    // 窗口内两次：主模型 fetch 次数不变
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledTimes(3);

    // 到期半开：主模型恢复 → 直接用主模型答案并闭合
    vi.setSystemTime(new Date("2026-09-09T12:01:01Z"));
    fetchMock.mockImplementation(async () => okJson("primary back"));
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("primary back");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(primaryBreakerState().open).toBe(false);
    expect(ai.run).toHaveBeenCalledTimes(3);
  });

  it("半开重试再失败 ⇒ 重新计窗（trip #2）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");
    await chatComplete({ ...ENV, AI: ai }, OPTS);
    vi.setSystemTime(new Date("2026-09-09T12:01:01Z"));
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const st = primaryBreakerState();
    expect(st).toMatchObject({ open: true, trips: 2 });
    expect(st.until).toBe(new Date("2026-09-09T12:02:01Z").getTime());
  });

  it("5xx（重试后仍失败）与 429 也熔断；402/401 等快失败不熔断（每次仍试主模型）", async () => {
    const ai = makeAi("fb");
    const f5 = vi.fn(async () => status(502));
    vi.stubGlobal("fetch", f5);
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(f5).toHaveBeenCalledTimes(2); // 既有：5xx 一次重试
    expect(primaryBreakerState().open).toBe(true);

    resetPrimaryBreaker();
    const f402 = vi.fn(async () => status(402));
    vi.stubGlobal("fetch", f402);
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(f402).toHaveBeenCalledTimes(2); // 每次都试主模型（402 不重试、不熔断）
    expect(primaryBreakerState()).toMatchObject({ open: false, trips: 0 });

    resetPrimaryBreaker();
    const f401 = vi.fn(async () => status(401));
    vi.stubGlobal("fetch", f401);
    await chatComplete({ ...ENV, AI: ai }, OPTS);
    expect(primaryBreakerState().open).toBe(false);
  });

  it("无 fallback（AI_FALLBACK_MODEL=none）时不熔断：每次都试主模型，返回 null", async () => {
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...ENV, AI_FALLBACK_MODEL: "none" };
    expect(await chatComplete(env, OPTS)).toBeNull();
    expect(await chatComplete(env, OPTS)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(primaryBreakerState()).toMatchObject({ open: false, trips: 0 });
  });

  it("AI_BREAKER_MS=0 关闭熔断（行为与 R337 前逐字相同：每次等主模型失败再回落）", async () => {
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");
    const env = { ...ENV, AI: ai, AI_BREAKER_MS: "0" };
    expect(await chatComplete(env, OPTS)).toBe("fb");
    expect(await chatComplete(env, OPTS)).toBe("fb");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(primaryBreakerState().open).toBe(false);
  });

  it("AI_BREAKER_MS 自定义窗口生效；非法值回落默认 60s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");
    await chatComplete({ ...ENV, AI: ai, AI_BREAKER_MS: "5000" }, OPTS);
    expect(primaryBreakerState().until).toBe(new Date("2026-09-09T12:00:05Z").getTime());
    resetPrimaryBreaker();
    await chatComplete({ ...ENV, AI: ai, AI_BREAKER_MS: "abc" }, OPTS);
    expect(primaryBreakerState().until).toBe(new Date("2026-09-09T12:01:00Z").getTime());
  });
});

describe("R338 primary breaker (chatCompleteStream + aiProbe)", () => {
  it("流式与非流式共用同一熔断器：流式超时熔断后，非流式直走 fallback；流式在窗口内也直走 fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");
    const deltas: string[] = [];
    expect(await chatCompleteStream({ ...ENV, AI: ai }, OPTS, (t) => deltas.push(t))).toBe("fb");
    expect(deltas).toEqual(["fb"]);
    expect(primaryBreakerState().open).toBe(true);
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("fb");
    expect(await chatCompleteStream({ ...ENV, AI: ai }, OPTS, () => {})).toBe("fb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流式主模型成功闭合熔断器", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("fb");
    await chatComplete({ ...ENV, AI: ai }, OPTS);
    vi.setSystemTime(new Date("2026-09-09T12:01:01Z"));
    fetchMock.mockImplementation(async () => sseBody(["主", "模型"]));
    const deltas: string[] = [];
    expect(await chatCompleteStream({ ...ENV, AI: ai }, OPTS, (t) => deltas.push(t))).toBe("主模型");
    expect(deltas).toEqual(["主", "模型"]);
    expect(primaryBreakerState().open).toBe(false);
  });

  it("aiProbe 绕过熔断器：窗口内仍探主模型并如实报告；探针成功闭合、探针失败不熔断", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    const fetchMock = timingOut();
    vi.stubGlobal("fetch", fetchMock);
    const ai = makeAi("ok");
    await chatComplete({ ...ENV, AI: ai }, OPTS);
    expect(primaryBreakerState().open).toBe(true);

    // 探针失败：报 fallback，不改变 trips、不延长窗口
    const before = primaryBreakerState();
    vi.setSystemTime(new Date("2026-09-09T12:00:30Z"));
    const p1 = await aiProbe({ ...ENV, AI: ai });
    expect(p1.provider).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(primaryBreakerState()).toEqual(before);

    // 探针成功：主模型口径 + 闭合
    fetchMock.mockImplementation(async () => okJson("ok"));
    const p2 = await aiProbe({ ...ENV, AI: ai });
    expect(p2.provider).toBe("primary");
    expect(primaryBreakerState().open).toBe(false);
    expect(await chatComplete({ ...ENV, AI: ai }, OPTS)).toBe("ok");
  });

  it("mock 模型不触碰熔断器", async () => {
    expect(await chatComplete({ ...ENV, AI_MODEL: "mock" }, OPTS)).toContain("mock");
    expect(primaryBreakerState()).toEqual({ open: false, until: null, trips: 0 });
  });
});

describe("R338 /health?probe=ai breaker 视图", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const env = { AI_MODEL: "mock", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", ADMIN_TOKEN: "adm-secret" };

  it("admin 看到顶层 breaker 链状态；ai 探针对象形状不变（R166 契约）", async () => {
    const { app } = await import("../src/index");
    const res = await app.request(new Request("http://x/health?probe=ai", { headers: { authorization: "Bearer adm-secret" } }), undefined, env, ctx);
    const body = (await res.json()) as { ai: Record<string, unknown>; breaker: unknown };
    expect(body.ai).toEqual({ ok: true, provider: "mock", model: "mock", degraded: false });
    expect(body.breaker).toEqual({ open: false, until: null, trips: 0 });
  });

  it("非 admin 看不到 breaker（不暴露链配置指纹）", async () => {
    const { app } = await import("../src/index");
    const res = await app.request(new Request("http://x/health?probe=ai"), undefined, env, ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, ai: { ok: true, degraded: false } });
  });
});
