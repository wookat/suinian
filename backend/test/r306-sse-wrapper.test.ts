// R306 生产回归（SSE 22/22 → error 500「This ReadableStream is currently locked」）：
// /api/ask 的 SSE 包装中间件为了先发 meta 提前把包装响应交给 Hono，此时
// c.finalized=true，路由 handler 之后 `return new Response(...)` 会被 compose
// 丢弃，中间件读到的 c.res 是包装流自己。本文件固化中间件依赖的 Hono 契约：
// 提前 finalize 后必须在 next() 之前重置 finalized，路由返回值才会落到 c.res。
import { describe, it, expect } from "vitest";
import { Hono } from "hono";

function buildApp(resetFinalized: boolean) {
  const app = new Hono();
  const seen: { inner: string | null } = { inner: null };
  app.use("/x", async (c, next) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(k) {
        ctrl = k;
      },
    });
    const wrapper = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const run = async () => {
      await new Promise((r) => setTimeout(r, 0));
      if (resetFinalized) c.finalized = false;
      await next();
      seen.inner = c.res === wrapper ? "<wrapper>" : await c.res.clone().text();
      ctrl.enqueue(new TextEncoder().encode(`data: ${seen.inner}\n\n`));
      ctrl.close();
    };
    void run();
    c.res = wrapper;
  });
  app.get("/x", () => new Response("inner-body", { headers: { "content-type": "text/plain" } }));
  return { app, seen };
}

describe("R306 SSE 包装：提前 finalize 后路由返回值的捕获", () => {
  it("不重置 finalized → 路由返回值被丢弃，c.res 仍是包装流（缺陷复现）", async () => {
    const { app, seen } = buildApp(false);
    const res = await app.request("/x");
    expect(await res.text()).toBe("data: <wrapper>\n\n");
    expect(seen.inner).toBe("<wrapper>");
  });
  it("重置 finalized → 路由返回值落到 c.res，包装流拿到真实响应体", async () => {
    const { app, seen } = buildApp(true);
    const res = await app.request("/x");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("data: inner-body\n\n");
    expect(seen.inner).toBe("inner-body");
  });
});
