import { describe, it, expect, vi } from "vitest";
import { topicEnumIntent, enumListIntent, resolveAskEnumIntent } from "../src/ask";

type AiEnv = Parameters<typeof resolveAskEnumIntent>[0];

function fakeAiEnv(reply: string | null, onRun?: () => void): AiEnv {
  return {
    AI_MODEL: "workers-ai:test-model",
    AI: {
      run: async () => {
        onRun?.();
        return { response: reply ?? undefined };
      },
    } as unknown as Ai,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    AI_BASE_URL: "",
  };
}

const deadAiEnv: AiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "", AI_BASE_URL: "" };

describe("topicEnumIntent generic-fragment guard (R150 P1-1)", () => {
  it("no longer captures the single-char fragment 什 from 「都记了些什么」", () => {
    expect(topicEnumIntent("上个月都记了些什么？")).toBeNull();
    expect(topicEnumIntent("这周都写了些什么")).toBeNull();
    expect(enumListIntent("上个月都记了些什么？")).toBe(true);
  });

  it("still extracts concrete topics", () => {
    expect(topicEnumIntent("我看过什么书")).toBe("书");
    expect(topicEnumIntent("存过哪些菜谱")).toBe("菜谱");
  });
});

describe("resolveAskEnumIntent (R150 P1-1)", () => {
  it("routes 「上个月都记了些什么」 to enum_list without calling the LLM", async () => {
    const runs = vi.fn();
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"topic_enum","topic":"书"}', runs), "上个月都记了些什么？", "上个月都记了些什么？");
    expect(route).toEqual({ topic: null, list: true, extreme: null });
    expect(runs).not.toHaveBeenCalled();
  });

  it("routes an unambiguous topic question by regex without calling the LLM", async () => {
    const runs = vi.fn();
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"enum_list"}', runs), "我看过什么书", "我看过什么书");
    expect(route).toEqual({ topic: "书", list: false, extreme: null });
    expect(runs).not.toHaveBeenCalled();
  });

  it("lets the LLM arbitrate cross-family ambiguity (both regexes hit)", async () => {
    // both families hit: 「都记了些什么健身的笔记」 topic=健身 + enumList wording
    const q = "都记了些什么健身的笔记";
    expect(topicEnumIntent(q)).toBe("健身");
    expect(enumListIntent(q)).toBe(true);
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"topic_enum","topic":"健身"}'), q, q);
    expect(route).toEqual({ topic: "健身", list: false, extreme: null });
    const route2 = await resolveAskEnumIntent(fakeAiEnv('{"intent":"enum_list"}'), q, q);
    expect(route2).toEqual({ topic: null, list: true, extreme: null });
  });

  it("falls back fail-closed to the regex preference when the LLM is unavailable", async () => {
    const q = "都记了些什么健身的笔记";
    const route = await resolveAskEnumIntent(deadAiEnv, q, q);
    expect(route).toEqual({ topic: "健身", list: false, extreme: null });
  });

  it("cross-family misroute matrix: precise routes stay mutually exclusive (R150 D-4)", async () => {
    // 历轮误路由高危措辞：每题断言唯一命中的路由家族，新家族合入时先过此门槛
    const cases: Array<{ q: string; topic: string | null; list: boolean }> = [
      { q: "上个月都记了些什么？", topic: null, list: true },
      { q: "上周都记了什么", topic: null, list: true },
      { q: "这个月都写了些什么", topic: null, list: true },
      { q: "我看过什么书", topic: "书", list: false },
      { q: "存过哪些菜谱", topic: "菜谱", list: false },
      { q: "记过哪些关于健身的想法", topic: "健身", list: false },
      { q: "最近过得怎么样", topic: null, list: false },
    ];
    for (const c of cases) {
      const route = await resolveAskEnumIntent(deadAiEnv, c.q, c.q);
      expect(route, c.q).toEqual({ topic: c.topic, list: c.list, extreme: null });
    }
  });

  it("uses the LLM when neither regex hits, honoring extreme routes", async () => {
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"extreme","extreme":"earliest"}'), "我的第一条笔记是什么", "我的第一条笔记是什么");
    expect(route).toEqual({ topic: null, list: false, extreme: "earliest" });
  });

  it("returns the neutral route when nothing matches", async () => {
    const route = await resolveAskEnumIntent(fakeAiEnv('{"intent":"general"}'), "最近过得怎么样", "最近过得怎么样");
    expect(route).toEqual({ topic: null, list: false, extreme: null });
  });
});
