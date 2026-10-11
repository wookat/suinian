import { describe, it, expect } from "vitest";
import { askAnswerCacheable } from "../src/index";

// R339：「（AI 暂不可用）已找到相关记录」类兜底是 provider 当下状态的产物，不进 180s 答案缓存；
// 否则模型恢复（或 R338 熔断闭合）后同问在 TTL 内仍拿旧兜底。正常答案缓存口径不变。
describe("R339 askAnswerCacheable", () => {
  it("200 + 正常答案可缓存", () => {
    expect(askAnswerCacheable({ answer: "咖啡豆是耶加雪菲 [1]", references: [], notes: [] }, 200)).toBe(true);
  });

  it("200 + ai_unavailable 兜底不缓存", () => {
    expect(
      askAnswerCacheable({ answer: "（AI 暂不可用）已找到相关记录，见 references。", references: [], notes: [], ai_unavailable: true }, 200)
    ).toBe(false);
  });

  it("非 200 一律不缓存；ai_unavailable 只认布尔 true", () => {
    expect(askAnswerCacheable({ answer: "x" }, 429)).toBe(false);
    expect(askAnswerCacheable({ answer: "x" }, 500)).toBe(false);
    expect(askAnswerCacheable({ answer: "x", ai_unavailable: "true" }, 200)).toBe(true);
    expect(askAnswerCacheable({ answer: "x", ai_unavailable: false }, 200)).toBe(true);
  });
});
