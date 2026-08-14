// R124 回归实测发现：纠错 LLM 对含「银行卡密码是…」的转写会拒答，拒答文案被
// 当成纠错结果写入笔记（原话静默丢失且复判为非敏感）。命中拒答特征必须回退原文。
import { describe, it, expect } from "vitest";
import { isCorrectionRefusal } from "../src/media";

describe("isCorrectionRefusal", () => {
  const raw = "我的银行卡密码是一二三四五六";

  it("拒答文案命中", () => {
    expect(isCorrectionRefusal("抱歉，我无法协助处理涉及银行卡密码的内容。", raw)).toBe(true);
    expect(isCorrectionRefusal("作为AI助手，我不能提供此类敏感信息的处理。", raw)).toBe(true);
    expect(isCorrectionRefusal("I'm sorry, I cannot help with that.", raw)).toBe(true);
  });

  it("正常纠错不误伤", () => {
    expect(isCorrectionRefusal("我的银行卡密码是123456", raw)).toBe(false);
    expect(isCorrectionRefusal("记一下，我把银行卡密码改成了998877", "记一下 我把银行卡密码改成了 九九八八七七")).toBe(false);
  });

  it("长度严重失真视为异常回退", () => {
    expect(isCorrectionRefusal("好", raw)).toBe(true);
    expect(isCorrectionRefusal(raw.repeat(10), raw)).toBe(true);
  });
});
