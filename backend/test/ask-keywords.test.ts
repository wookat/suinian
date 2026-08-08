import { describe, it, expect } from "vitest";
import { needsCjkKeywordExtraction, needsBilingualKeywordExtraction, extractAskKeywords, extractAskTerms } from "../src/index";

type AiEnv = Parameters<typeof extractAskKeywords>[0];

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

describe("needsCjkKeywordExtraction", () => {
  it("triggers on long unsegmented CJK clauses", () => {
    const terms = extractAskTerms("最近几天收藏的那个咖啡视频讲什么", []);
    expect(needsCjkKeywordExtraction(terms)).toBe(true);
  });

  it("triggers when no terms survived splitting", () => {
    expect(needsCjkKeywordExtraction([])).toBe(true);
  });

  it("does not trigger on already-short CJK terms", () => {
    expect(needsCjkKeywordExtraction(["周报", "计划"])).toBe(false);
  });

  it("does not trigger on long non-CJK terms (english words/urls)", () => {
    expect(needsCjkKeywordExtraction(["cloudflare", "workers-deployment"])).toBe(false);
  });
});

describe("needsBilingualKeywordExtraction", () => {
  it("triggers on pure-English questions", () => {
    expect(needsBilingualKeywordExtraction("What is my latest plan for the coffee shop idea?")).toBe(true);
  });

  it("does not trigger when the question contains CJK", () => {
    expect(needsBilingualKeywordExtraction("咖啡馆的 plan 是什么")).toBe(false);
  });

  it("does not trigger on non-letter questions (numbers/punctuation)", () => {
    expect(needsBilingualKeywordExtraction("123 456?")).toBe(false);
  });
});

describe("extractAskKeywords", () => {
  it("parses space-separated keywords from the model output", async () => {
    const env = fakeAiEnv("咖啡 视频 收藏");
    expect(await extractAskKeywords(env, "最近几天收藏的那个咖啡视频讲什么")).toEqual([
      "咖啡",
      "视频",
      "收藏",
    ]);
  });

  it("tolerates comma/顿号 separators and drops overlong or 1-char pieces", async () => {
    const env = fakeAiEnv("咖啡，视频、啊 这是一个特别长超过十二个字的关键词短语");
    expect(await extractAskKeywords(env, "问题")).toEqual(["咖啡", "视频"]);
  });

  it("caps at 6 keywords", async () => {
    const env = fakeAiEnv("k1 k2 k3 k4 k5 k6 k7 k8");
    expect(await extractAskKeywords(env, "问题")).toHaveLength(6);
  });

  it("returns [] when the AI is unavailable", async () => {
    const env: AiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "", AI_BASE_URL: "" };
    expect(await extractAskKeywords(env, "问题")).toEqual([]);
  });

  it("returns [] on empty output", async () => {
    expect(await extractAskKeywords(fakeAiEnv("   "), "问题")).toEqual([]);
  });
});
