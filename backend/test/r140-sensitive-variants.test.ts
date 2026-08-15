import { describe, it, expect } from "vitest";
import { detectSensitive, maybeSensitive, normalizeDigitRuns } from "../src/triage";
import { topicEnumIntent, enumListIntent } from "../src/ask";

// R140 P1：带分隔/全角的数字类敏感值不得绕过兜底正则（R139 生产实测漏网）
describe("normalizeDigitRuns", () => {
  it("折叠数字组之间的空格/连字符，全角数字转半角", () => {
    expect(normalizeDigitRuns("6222 0000 1111 2222")).toBe("6222000011112222");
    expect(normalizeDigitRuns("6222-0000-1111-2222")).toBe("6222000011112222");
    expect(normalizeDigitRuns("６２２２００００１１１１２２２２")).toBe("6222000011112222");
    expect(normalizeDigitRuns("138 1234 5678")).toBe("13812345678");
  });

  it("不动非数字间隔的文本", () => {
    expect(normalizeDigitRuns("今天 3 点开会，花了 42 元")).toBe("今天 3 点开会，花了 42 元");
  });
});

describe("detectSensitive 数字类对抗变体", () => {
  it("银行卡号：空格/连字符/全角/混合分段都判敏感", () => {
    expect(detectSensitive("银行卡号 6222 0000 1111 2222")).toBe(true);
    expect(detectSensitive("卡号：6222-0000-1111-2222")).toBe(true);
    expect(detectSensitive("信用卡 ６２２２ ００００ １１１１ ２２２２")).toBe(true);
    expect(detectSensitive("储蓄卡 6222 00001111-2222")).toBe(true);
    // 原有连续写法不回归
    expect(detectSensitive("银行卡号 6222000011112222")).toBe(true);
  });

  it("身份证号：带空格分段也判敏感", () => {
    expect(detectSensitive("身份证 110101 1990 0101 1234")).toBe(true);
    expect(detectSensitive("身份证 110101199001011234")).toBe(true);
  });

  it("手机号：关键词 + 分段号码判敏感", () => {
    expect(detectSensitive("张三手机号 138 1234 5678")).toBe(true);
    expect(detectSensitive("电话：138-1234-5678")).toBe(true);
  });

  it("普通含数字文本不误伤", () => {
    expect(detectSensitive("今天花了 42 元买咖啡")).toBe(false);
    expect(detectSensitive("会议改到 2026-08-15 15:00")).toBe(false);
    expect(detectSensitive("跑步 5 公里用了 28 分 30 秒")).toBe(false);
  });

  it("maybeSensitive 对变体同样 fail-closed", () => {
    expect(maybeSensitive("银行卡号 6222 0000 1111 2222")).toBe(true);
  });
});

// R140 P2：主题限定的「记过哪些…」不再被无主题全量枚举劫持
describe("topicEnumIntent 优先于 enumListIntent", () => {
  it("「记过哪些关于 X 的想法」提取主题词", () => {
    expect(topicEnumIntent("我记过哪些关于 AI 创业的想法？")).toBe("AI 创业");
    expect(topicEnumIntent("记过哪些关于健身的笔记")).toBe("健身");
  });

  it("无主题的时间窗枚举仍走 enumList", () => {
    expect(topicEnumIntent("上周都记了什么")).toBeNull();
    expect(enumListIntent("上周都记了什么")).toBe(true);
    expect(topicEnumIntent("我都记过哪些东西")).toBeNull();
  });

  it("既有主题枚举句式不回归", () => {
    expect(topicEnumIntent("我看过什么书")).toBe("书");
    expect(topicEnumIntent("关于健身的笔记有哪些")).toBe("健身");
  });
});
