/**
 * R298 P1-3（audit-r297 §6）：幻觉凭据拒答。
 * 判据：答案断言「<凭据词> 是 <高熵串>」且该串不在引用笔记明文中 ⇒ 拒答。
 * 明文里确有该串（用户自己记的普通笔记）⇒ 不在此拦，由既有敏感规则处理。
 */
import { describe, it, expect } from "vitest";
import {
  finalizeAskAnswer,
  credentialAssertionReason,
  CREDENTIAL_REFUSAL_ANSWER,
} from "../src/prompt-armor";

const fin = (answer: string, dataText = "普通笔记：今天天气不错。") =>
  finalizeAskAnswer(answer, { dataText, question: "我的服务器密码是多少？" });

describe("R298 P1-3 幻觉凭据拒答", () => {
  const HALLUCINATED: Array<[string, string]> = [
    ["R297 原例", "你的服务器密码是 1234567890abcdef。"],
    ["中文·密钥", "这台机器的密钥为 A9f3kQz8xY。"],
    ["中文·验证码", "验证码是 934217。"],
    ["中文·口令冒号", "Wi-Fi 口令：Zx9!mQ2#pL"],
    ["英文·password is", "Your password is hunter2AB9."],
    ["英文·api key", "The API key is sk-abcdef1234567890."],
    ["英文·token =", "token = ghp_a1B2c3D4e5F6g7"],
    ["日文·パスワード", "サーバーのパスワードは 8f2e9c1d7b です。"],
    ["韩文·비밀번호", "서버 비밀번호는 Qw8!zX2#9a 입니다."],
    ["秘钥引号", "数据库私钥是「e3b0c44298fc1c14」，请妥善保管。"],
  ];
  for (const [kind, ans] of HALLUCINATED) {
    it(`拒答：${kind}`, () => {
      expect(credentialAssertionReason(ans, "普通笔记：今天天气不错。")).not.toBeNull();
      const f = fin(ans);
      expect(f.answer).toBe(CREDENTIAL_REFUSAL_ANSWER);
      expect(f.isolated).toBe(true);
    });
  }

  it("明文可核对的凭据不在此拦（交由既有敏感规则）", () => {
    const data = "笔记：路由器管理密码是 Zx9!mQ2#pL，记得改掉。";
    expect(credentialAssertionReason("路由器管理密码是 Zx9!mQ2#pL。", data)).toBeNull();
  });

  const BENIGN: Array<[string, string]> = [
    ["普通散文", "今天读完了一本书，记录了三条心得。"],
    ["低熵描述", "密码是你自己设置的那个，我这里看不到。"],
    ["指引不给值", "The password is stored in your .env file."],
    ["谈论概念", "密钥是一种用于加密的随机字符串，长度通常为 32 字节。"],
    ["财务金额", "本月合计支出为 123456 元。"],
  ];
  for (const [kind, ans] of BENIGN) {
    it(`不误伤：${kind}`, () => {
      expect(credentialAssertionReason(ans, "普通笔记")).toBeNull();
    });
  }
});
