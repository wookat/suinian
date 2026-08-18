// R176: P1-1 Workers AI 流字段类型判别（response 对 `[3]` token 是 JSON 数组，
// 不得字符串化进正文）、P1-2 元问题不被改写后的财务上下文劫持、P2-2 财务
// 极值同义词补全。
import { describe, it, expect } from "vitest";
import { chatComplete, chatCompleteStream } from "../src/ai";
import { financeExtremeIntent, reconcileAskCitations, ASK_META_QUESTION_RE } from "../src/ask";
import type { Env } from "../src/types";

const sse = (frames: unknown[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
};

const workersAiEnv = (frames: unknown[]): Pick<Env, "AI" | "AI_MODEL" | "AI_FALLBACK_MODEL"> =>
  ({
    AI: { run: async () => sse(frames) } as unknown as Ai,
    AI_MODEL: "workers-ai:@cf/test",
    AI_FALLBACK_MODEL: "none",
  }) as Pick<Env, "AI" | "AI_MODEL" | "AI_FALLBACK_MODEL">;

describe("Workers AI stream parsing (R176 P1-1)", () => {
  it("prefers canonical choices[0].delta.content over response", async () => {
    const env = workersAiEnv([
      { choices: [{ delta: { content: "根据笔记" } }], response: "WRONG" },
      { choices: [{ delta: { content: " [3]" } }], response: [3] },
      { choices: [{ delta: { content: "。" } }], response: "。" },
    ]);
    const deltas: string[] = [];
    const full = await chatCompleteStream(env as Env, { messages: [{ role: "user", content: "q" }] }, (t) => deltas.push(t));
    expect(full).toBe("根据笔记 [3]。");
    expect(deltas.join("")).toBe("根据笔记 [3]。");
  });

  it("drops structured response frames instead of stringifying them", async () => {
    // 无 choices 字段、response 为 JSON 数组的帧（R175 P1-1 实录 `[3]` token）
    const env = workersAiEnv([{ response: "答案是" }, { response: [3] }, { response: "，见上" }]);
    const full = await chatCompleteStream(env as Env, { messages: [{ role: "user", content: "q" }] }, () => {});
    expect(full).toBe("答案是，见上");
    expect(full).not.toContain("3");
  });

  it("falls back to string response when choices is absent", async () => {
    const env = workersAiEnv([{ response: "整段" }, { response: "回答 [1]" }]);
    const full = await chatCompleteStream(env as Env, { messages: [{ role: "user", content: "q" }] }, () => {});
    expect(full).toBe("整段回答 [1]");
  });

  it("citation markers surviving the stream reconcile to reference cards", async () => {
    const env = workersAiEnv([
      { choices: [{ delta: { content: "综合 [2]" } }], response: [2] },
      { choices: [{ delta: { content: " 和 [3]" } }], response: [3] },
    ]);
    const full = await chatCompleteStream(env as Env, { messages: [{ role: "user", content: "q" }] }, () => {});
    const { answer, references } = reconcileAskCitations(full ?? "", ["a", "b", "c"], new Set());
    expect(answer).toBe("综合 [1] 和 [2]");
    expect(references).toEqual([
      { index: 1, note_id: "b" },
      { index: 2, note_id: "c" },
    ]);
  });
});

describe("Workers AI non-streaming parsing (R176 P1-1)", () => {
  const nonStreamEnv = (out: unknown): Pick<Env, "AI" | "AI_MODEL" | "AI_FALLBACK_MODEL"> =>
    ({
      AI: { run: async () => out } as unknown as Ai,
      AI_MODEL: "workers-ai:@cf/test",
      AI_FALLBACK_MODEL: "none",
    }) as Pick<Env, "AI" | "AI_MODEL" | "AI_FALLBACK_MODEL">;

  it("prefers choices[0].message.content", async () => {
    const env = nonStreamEnv({ response: "WRONG", choices: [{ message: { content: "对 [1]" } }] });
    expect(await chatComplete(env as Env, { messages: [{ role: "user", content: "q" }] })).toBe("对 [1]");
  });

  it("accepts string response, rejects structured response", async () => {
    expect(await chatComplete(nonStreamEnv({ response: "纯文本" }) as Env, { messages: [{ role: "user", content: "q" }] })).toBe("纯文本");
    expect(await chatComplete(nonStreamEnv({ response: [3] }) as Env, { messages: [{ role: "user", content: "q" }] })).toBe(null);
  });
});

describe("meta-question detection (R176 P1-2)", () => {
  it("matches recent-thoughts / summary meta questions", () => {
    expect(ASK_META_QUESTION_RE.test("我最近在想什么")).toBe(true);
    expect(ASK_META_QUESTION_RE.test("帮我总结一下最近的笔记")).toBe(true);
    expect(ASK_META_QUESTION_RE.test("我最近在忙什么")).toBe(true);
  });
  it("does not match concrete topical questions", () => {
    expect(ASK_META_QUESTION_RE.test("这个月最大的一笔支出是什么")).toBe(false);
    expect(ASK_META_QUESTION_RE.test("土鸡蛋报价是多少")).toBe(false);
  });
});

describe("financeExtremeIntent (R176 P2-2 synonyms)", () => {
  it("routes broadened max-expense wording", () => {
    expect(financeExtremeIntent("金额最大的一笔支出是什么")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("我花钱最狠的一笔是什么")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("哪笔消费数额最大")).toEqual({ kind: "max", direction: "expense", rank: 1 });
  });
  it("keeps original routing intact", () => {
    expect(financeExtremeIntent("最贵的一笔支出是什么")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("最便宜的一笔消费是什么")).toEqual({ kind: "min", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("收入最高的一笔是什么")).toEqual({ kind: "max", direction: "income", rank: 1 });
  });
  it("does not fire on non-finance questions (meta question stays free)", () => {
    expect(financeExtremeIntent("我最近在想什么")).toBe(null);
  });
});
