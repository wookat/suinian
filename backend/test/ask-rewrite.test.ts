import { describe, it, expect } from "vitest";
import { rewriteAskQuestion, type AskHistoryMessage } from "../src/index";

type AiEnv = Parameters<typeof rewriteAskQuestion>[0];

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

const HISTORY: AskHistoryMessage[] = [
  { role: "user", content: "我这周有什么待办？" },
  { role: "assistant", content: "有两条：[1] 交周报，[2] 提交报销单。" },
];

describe("rewriteAskQuestion", () => {
  it("skips the AI call when there is no history", async () => {
    const env = fakeAiEnv("不应被使用");
    expect(await rewriteAskQuestion(env, "我这周有什么待办？", [])).toBe("我这周有什么待办？");
  });

  it("returns the AI-rewritten standalone question", async () => {
    const env = fakeAiEnv("提交报销单这条待办什么时候截止？");
    expect(await rewriteAskQuestion(env, "第二个什么时候截止？", HISTORY)).toBe(
      "提交报销单这条待办什么时候截止？"
    );
  });

  it("falls back to the original question when the AI is unavailable", async () => {
    const env: AiEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "", AI_MODEL: "", AI_BASE_URL: "" };
    expect(await rewriteAskQuestion(env, "具体几点？", HISTORY)).toBe("具体几点？");
  });

  it("falls back when the AI returns empty or overly long output", async () => {
    expect(await rewriteAskQuestion(fakeAiEnv("   "), "具体几点？", HISTORY)).toBe("具体几点？");
    expect(await rewriteAskQuestion(fakeAiEnv("啰".repeat(400)), "具体几点？", HISTORY)).toBe("具体几点？");
  });
});
