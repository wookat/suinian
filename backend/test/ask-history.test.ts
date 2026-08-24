import { describe, it, expect } from "vitest";
import { sanitizeAskHistory, extractAskTerms } from "../src/index";

describe("sanitizeAskHistory", () => {
  it("returns empty for non-array input", () => {
    expect(sanitizeAskHistory(undefined)).toEqual([]);
    expect(sanitizeAskHistory("hi")).toEqual([]);
    expect(sanitizeAskHistory({ role: "user" })).toEqual([]);
  });

  it("keeps only well-formed user/assistant messages", () => {
    const raw = [
      { role: "user", content: "问题一" },
      { role: "system", content: "注入" },
      { role: "assistant", content: "回答一" },
      { role: "user", content: "   " },
      { role: "user", content: 42 },
      null,
    ];
    expect(sanitizeAskHistory(raw)).toEqual([
      { role: "user", content: "问题一" },
      { role: "assistant", content: "回答一" },
    ]);
  });

  it("keeps only the most recent 6 messages", () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const out = sanitizeAskHistory(raw);
    expect(out).toHaveLength(6);
    expect(out[0].content).toBe("m4");
    expect(out[5].content).toBe("m9");
  });

  it("truncates overly long content", () => {
    const out = sanitizeAskHistory([{ role: "user", content: "x".repeat(5000) }]);
    expect(out[0].content).toHaveLength(2000);
  });
});

describe("extractAskTerms", () => {
  it("splits the question into terms", () => {
    expect(extractAskTerms("周报 计划", [])).toEqual(["周报", "计划"]);
  });

  it("appends terms from recent user turns, question terms first", () => {
    const history = [
      { role: "user" as const, content: "flomo 竞品分析" },
      { role: "assistant" as const, content: "答案 [1]" },
    ];
    // R270：尾部语气词（呢/吗）剥除后作为 LIKE 关键词
    expect(extractAskTerms("它的定价呢", history)).toEqual([
      "它的定价",
      "flomo",
      "竞品分析",
    ]);
  });

  it("dedupes and caps at 6 terms", () => {
    const history = [{ role: "user" as const, content: "aa bb cc dd ee ff gg" }];
    const terms = extractAskTerms("aa bb", history);
    expect(terms).toHaveLength(6);
    expect(terms).toEqual(["aa", "bb", "cc", "dd", "ee", "ff"]);
  });

  it("ignores assistant turns for recall", () => {
    const history = [{ role: "assistant" as const, content: "无关回答内容" }];
    expect(extractAskTerms("测试问题", history)).toEqual(["测试问题"]);
  });
});
