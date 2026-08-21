import { describe, it, expect } from "vitest";
import { buildTriagePrompt } from "../src/triage";

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

// ---- P2-1（audit-r229 §3）：「垫付回款」方向误判 few-shot 回流 ----
describe("R230 P2-1 past-advance repayment few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the production-misjudged sentence as income", () => {
    expect(prompt).toContain("上次帮小刘垫的 90 他微信转我了");
  });
  it("includes the 还我 variant as income", () => {
    expect(prompt).toContain("帮同事垫的 90 块他今天微信还我了");
  });
  it("keeps the R220 cross-time advance repayment judgements (不回归)", () => {
    expect(prompt).toContain("昨天垫付的地铁卡 200，今天他还我 200");
    expect(prompt).toContain("朋友把上次帮他垫的 300 元还我了");
  });
});

// ---- P3-1（audit-r229 §3）：「抵完后的价」已是净额，红包/券不得再减 ----
describe("R230 P3-1 already-net price few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the 红包抵完后的价 judgement", () => {
    expect(prompt).toContain("外卖凑单花了 66.6，红包抵了 3 块是抵完后的价");
    expect(prompt).toContain("绝不是 63.6");
  });
  it("includes the 券后价 variant", () => {
    expect(prompt).toContain("买水果 28.8，用了 5 元券后的价");
  });
  it("keeps mixed payment+refund netting judgements distinct (R228 不回归)", () => {
    expect(prompt).toContain("昨晚打车付款 34.5 其中退款 9");
    expect(prompt).toContain("付款合计−退款");
  });
});

// ---- P3-2（audit-r229 §1.2）论证不改：垫付×他人回款同句维持实付总额口径
//（audit-r215 §2.3 口径：amount=本人实付；回款另记一笔收入）----
describe("R230 P3-2 same-sentence advance+repay keeps total-amount口径", () => {
  it("prompt still records 480 (not netted 120)", () => {
    const prompt = buildTriagePrompt(NOW, [], TZ);
    expect(prompt).toContain("我先付了聚餐 480 元，其他人回我 360 元");
    expect(prompt).toContain("绝不是 120");
  });
});
