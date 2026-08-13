import { describe, it, expect, vi, afterEach } from "vitest";
import { chatComplete, aiProbe } from "../src/ai";

const OPTS = { messages: [{ role: "user" as const, content: "hi" }] };

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function balanceError(): Response {
  return new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 });
}

function makeAi(response: string | Error) {
  return {
    run: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return { response };
    }),
  } as unknown as Ai;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatComplete degradation chain", () => {
  it("uses the primary provider when it answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson("primary answer")));
    const ai = makeAi("fallback answer");
    const out = await chatComplete(
      { AI: ai, DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" },
      OPTS
    );
    expect(out).toBe("primary answer");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("falls back to Workers AI when the primary provider fails (e.g. insufficient balance)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const ai = makeAi("fallback answer");
    const out = await chatComplete(
      { AI: ai, DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" },
      OPTS
    );
    expect(out).toBe("fallback answer");
    expect(ai.run).toHaveBeenCalledWith("@cf/meta/llama-3.3-70b-instruct-fp8-fast", expect.anything());
  });

  it("falls back when the primary key is missing entirely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson("unused")));
    const ai = makeAi("fallback answer");
    const out = await chatComplete({ AI: ai, DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" }, OPTS);
    expect(out).toBe("fallback answer");
  });

  it("honours AI_FALLBACK_MODEL=none (chain disabled)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const ai = makeAi("fallback answer");
    const out = await chatComplete(
      { AI: ai, DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com", AI_FALLBACK_MODEL: "none" },
      OPTS
    );
    expect(out).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("supports a custom AI_FALLBACK_MODEL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const ai = makeAi("custom fallback");
    const out = await chatComplete(
      {
        AI: ai,
        DEEPSEEK_API_KEY: "k",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
        AI_FALLBACK_MODEL: "workers-ai:@cf/qwen/qwen2.5-coder-32b-instruct",
      },
      OPTS
    );
    expect(out).toBe("custom fallback");
    expect(ai.run).toHaveBeenCalledWith("@cf/qwen/qwen2.5-coder-32b-instruct", expect.anything());
  });

  it("returns null when both primary and fallback fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const ai = makeAi(new Error("workers ai down"));
    const out = await chatComplete(
      { AI: ai, DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" },
      OPTS
    );
    expect(out).toBeNull();
  });

  it("does not fall back to itself when the primary already is the fallback model", async () => {
    const ai = makeAi(new Error("workers ai down"));
    const out = await chatComplete(
      {
        AI: ai,
        DEEPSEEK_API_KEY: "",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
        AI_MODEL: "workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      },
      OPTS
    );
    expect(out).toBeNull();
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
});

describe("aiProbe", () => {
  it("reports primary when the primary provider answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson("ok")));
    const probe = await aiProbe({ AI: makeAi("ok"), DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" });
    expect(probe).toEqual({ ok: true, provider: "primary", model: "deepseek-chat" });
  });

  it("reports fallback when only the fallback answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const probe = await aiProbe({ AI: makeAi("ok"), DEEPSEEK_API_KEY: "k", DEEPSEEK_BASE_URL: "https://api.deepseek.com" });
    expect(probe.ok).toBe(true);
    expect(probe.provider).toBe("fallback");
  });

  it("reports down when every provider fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => balanceError()));
    const probe = await aiProbe({
      AI: makeAi(new Error("down")),
      DEEPSEEK_API_KEY: "k",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    });
    expect(probe).toEqual({ ok: false, provider: null, model: null });
  });

  it("reports mock in local dev", async () => {
    const probe = await aiProbe({ DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "mock" });
    expect(probe).toEqual({ ok: true, provider: "mock", model: "mock" });
  });
});
