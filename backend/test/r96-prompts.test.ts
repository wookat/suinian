import { describe, it, expect } from "vitest";
import { buildTriagePrompt, type CategoryCorrection } from "../src/triage";

describe("buildTriagePrompt category corrections (R96 few-shot)", () => {
  it("omits the correction section when there are none", () => {
    expect(buildTriagePrompt()).not.toContain("手动指定过");
  });

  it("injects the user's manual category choices as preferences", () => {
    const corrections: CategoryCorrection[] = [
      { content: "打车去机场 45 块", category: "expense" },
      { content: "周报模板放在共享盘", category: "data" },
    ];
    const p = buildTriagePrompt(new Date(), [], "Asia/Shanghai", corrections);
    expect(p).toContain("手动指定过");
    expect(p).toContain('「打车去机场 45 块」→ "expense"');
    expect(p).toContain('「周报模板放在共享盘」→ "data"');
  });

  it("keeps the anti-generic tag guidance", () => {
    expect(buildTriagePrompt()).toContain("不要一律套「购物」这类宽泛词");
  });
});
