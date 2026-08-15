import { describe, it, expect } from "vitest";
import { classifyAskIntent, validAskEnumTopic } from "../src/ask";

type AiEnv = Parameters<typeof classifyAskIntent>[0];

function fakeAiEnv(reply: string | null): AiEnv {
  return {
    AI_MODEL: "workers-ai:test-model",
    AI: {
      run: async () => ({ response: reply ?? undefined }),
    } as unknown as Ai,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "",
    AI_BASE_URL: "",
  };
}

describe("validAskEnumTopic", () => {
  it("accepts a concrete topic that appears in the question", () => {
    expect(validAskEnumTopic("书", "给我一份读过的书的清单")).toBe(true);
  });

  it("rejects topics not present in the question (hallucination guard)", () => {
    expect(validAskEnumTopic("菜谱", "给我一份读过的书的清单")).toBe(false);
  });

  it("rejects generic words", () => {
    expect(validAskEnumTopic("东西", "我记过哪些东西")).toBe(false);
    expect(validAskEnumTopic("笔记", "都有哪些笔记")).toBe(false);
  });

  it("rejects non-string / overlong topics", () => {
    expect(validAskEnumTopic(null, "问题")).toBe(false);
    expect(validAskEnumTopic("一二三四五六七八九十一二三", "一二三四五六七八九十一二三")).toBe(false);
  });
});

describe("classifyAskIntent", () => {
  it("parses a valid topic_enum classification", async () => {
    const env = fakeAiEnv('{"intent":"topic_enum","topic":"书"}');
    expect(await classifyAskIntent(env, "给我一份读过的书的清单")).toEqual({
      intent: "topic_enum",
      topic: "书",
      extreme: null,
    });
  });

  it("fails closed when the topic does not appear in the question", async () => {
    const env = fakeAiEnv('{"intent":"topic_enum","topic":"菜谱"}');
    expect(await classifyAskIntent(env, "给我一份读过的书的清单")).toBeNull();
  });

  it("parses enum_list", async () => {
    const env = fakeAiEnv('{"intent":"enum_list"}');
    expect(await classifyAskIntent(env, "上周的笔记清单")).toEqual({
      intent: "enum_list",
      topic: null,
      extreme: null,
    });
  });

  it("parses extreme with a valid kind", async () => {
    const env = fakeAiEnv('{"intent":"extreme","extreme":"earliest"}');
    expect(await classifyAskIntent(env, "我的第一条笔记是什么")).toEqual({
      intent: "extreme",
      topic: null,
      extreme: "earliest",
    });
  });

  it("fails closed on invalid extreme kind", async () => {
    const env = fakeAiEnv('{"intent":"extreme","extreme":"biggest"}');
    expect(await classifyAskIntent(env, "最大的一条")).toBeNull();
  });

  it("returns null for general", async () => {
    const env = fakeAiEnv('{"intent":"general"}');
    expect(await classifyAskIntent(env, "咖啡馆的计划是什么")).toBeNull();
  });

  it("tolerates prose around the JSON", async () => {
    const env = fakeAiEnv('好的，分类结果：{"intent":"enum_list"} 以上。');
    expect(await classifyAskIntent(env, "最近记的都有什么")).toEqual({
      intent: "enum_list",
      topic: null,
      extreme: null,
    });
  });

  it("fails closed on unknown intent / broken JSON / empty output", async () => {
    expect(await classifyAskIntent(fakeAiEnv('{"intent":"finance_agg"}'), "问题")).toBeNull();
    expect(await classifyAskIntent(fakeAiEnv('{"intent":'), "问题")).toBeNull();
    expect(await classifyAskIntent(fakeAiEnv("   "), "问题")).toBeNull();
  });

  it("fails closed when the AI is unavailable", async () => {
    const env: AiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "", AI_BASE_URL: "" };
    expect(await classifyAskIntent(env, "问题")).toBeNull();
  });
});
