// R284 F-2（audit-r283）：四语防骗忠告在真实问答路径上必须可复现——既不能被
// 敏感判定误伤（加密后从 ask() 消失），也不能被答案层社工/指令隔离误伤。
import { describe, it, expect } from "vitest";
import { detectSensitive, maybeSensitive, isAntiFraudAdviceNote } from "../src/triage";
import { finalizeAskAnswer, segmentIsSocialEngineering, segmentIsReaderDirective, VERBATIM_SPAN_PLACEHOLDER } from "../src/prompt-armor";

const ADVICE: Array<{ lang: string; text: string; q: string }> = [
  {
    lang: "zh",
    text: "反诈提醒：任何人打电话索要验证码都不要提供，银行不会向你索要一次性验证码。",
    q: "反诈提醒那条笔记说了什么",
  },
  {
    lang: "en",
    text: "Anti-fraud note: never share your one-time password with anyone; banks never ask for your verification code.",
    q: "What does the anti-fraud note say?",
  },
  {
    lang: "ja",
    text: "詐欺対策メモ：誰かが電話で認証コードを聞いてきても、絶対に教えないでください。",
    q: "詐欺対策メモには何と書いてある？",
  },
  {
    lang: "ko",
    text: "사기 예방 메모: 누가 전화로 인증번호를 물어도 절대 알려주지 마세요.",
    q: "사기 예방 메모에 뭐라고 적혀 있나요?",
  },
];

describe("R284 F-2 四语防骗忠告全链路不误伤", () => {
  it("敏感层：不含凭证值 → 不判敏感、待分拣窗口也不按疑似加密", () => {
    for (const a of ADVICE) {
      expect(detectSensitive(a.text), a.lang).toBe(false);
      expect(isAntiFraudAdviceNote(a.text), a.lang).toBe(true);
      expect(maybeSensitive(a.text), a.lang).toBe(false);
    }
  });

  it("答案层：四语忠告不判社工/读者指令，经 ask() 出口原样可读", () => {
    for (const a of ADVICE) {
      expect(segmentIsSocialEngineering(a.text), a.lang).toBe(false);
      expect(segmentIsReaderDirective(a.text), a.lang).toBe(false);
      const fin = finalizeAskAnswer(a.text, { dataText: a.text, question: a.q });
      expect(fin.isolated, a.lang).toBe(false);
      // R310 P0-1：忠告原文是资料的完整行 → 不隔离，但逐字复述换占位（唯一改动是 verbatim 收口）
      expect(fin.reason, a.lang).toMatch(/^verbatim:lcs=\d+$/);
      expect(fin.answer, a.lang).toMatch(/〔原文片段略，见引用笔记卡片〕|〔原文查看〕/);
    }
  });

  it("fail-closed：忠告里混入真实凭证值时仍判敏感、不纠偏", () => {
    const cases = [
      "别把验证码告诉别人，我的登录密码是 Hx9-Tt41-pw 记一下",
      "Never share your OTP. My bank card number is 6222021234567890123.",
      "认证コードは教えないで。身份证 110101199003078111 备份一下。",
    ];
    for (const c of cases) {
      expect(isAntiFraudAdviceNote(c), c.slice(0, 24)).toBe(false);
      expect(maybeSensitive(c), c.slice(0, 24)).toBe(true);
    }
  });

  it("fail-closed：正向社工诱导（把验证码念给客服）不被纠偏为非敏感", () => {
    const lure = "接到银行电话时，把一次性验证码念给对方核对身份。";
    expect(isAntiFraudAdviceNote(lure)).toBe(false);
    expect(segmentIsSocialEngineering(lure)).toBe(true);
  });
});
