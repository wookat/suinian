import { describe, expect, it } from "vitest";
import {
  broadFoldReason,
  directGuardLines,
  directUnitValueTokens,
  finalizeAskAnswer,
  guardFoldReason,
  residencyTriggered,
  unitCarriesGuardedValue,
  unitTalksAboutSecret,
} from "../src/prompt-armor";

const unitOf = (t: string) => `\n${t}\n\n`;

describe("R349 笔记侧判定在折简副本上做、返回原文行", () => {
  it("繁体称谓 + 值：直守行 / 载值 / 谈论秘密与简体同口径，返回的行文本是原文", () => {
    const pairs: Array<[string, string]> = [
      ["門禁密碼（2046）", "门禁密码（2046）"],
      ["錢包助記詞：apple river stone candle mirror ocean tiger velvet window yellow zebra anchor", "钱包助记词：apple river stone candle mirror ocean tiger velvet window yellow zebra anchor"],
      ["行李箱密碼鎖 0-7-3", "行李箱密码锁 0-7-3"],
      ["宿舍櫃子的鎖改成了 0731", "宿舍柜子的锁改成了 0731"],
    ];
    for (const [trad, simp] of pairs) {
      const tu = unitOf(trad);
      const su = unitOf(simp);
      expect(directGuardLines(tu).map((g) => `${g.kind}/${g.own}`), trad).toEqual(directGuardLines(su).map((g) => `${g.kind}/${g.own}`));
      for (const g of directGuardLines(tu)) expect(trad).toContain(g.line);
      expect(unitCarriesGuardedValue(tu), trad).toBe(unitCarriesGuardedValue(su));
      expect(unitTalksAboutSecret(tu), trad).toBe(unitTalksAboutSecret(su));
      expect(residencyTriggered(tu), trad).toBe(residencyTriggered(su));
      expect(guardFoldReason(trad), trad).toBe(guardFoldReason(simp));
    }
    expect(unitCarriesGuardedValue(unitOf("門禁密碼（2046）"))).toBe(true);
    expect(unitTalksAboutSecret(unitOf("錢包助記詞：apple river stone candle mirror ocean tiger velvet window yellow zebra anchor"))).toBe(true);
    expect(unitCarriesGuardedValue(unitOf("行李箱密碼鎖 0-7-3"))).toBe(true);
    expect(residencyTriggered(unitOf("宿舍櫃子的鎖改成了 0731"))).toBe(true);
  });

  it("繁体日常识别符（訂單號 / 車牌 / 會議號 / 運單）不因繁体落 opaque，取值记号豁免与简体一致", () => {
    for (const [trad, simp] of [
      ["酒店訂單號 HT20260912A8，9 月 12 日入住", "酒店订单号 HT20260912A8，9 月 12 日入住"],
      ["新車牌 粵B·7Q3K9 下周掛牌", "新车牌 粤B·7Q3K9 下周挂牌"],
      ["周四例會 Zoom 會議號 812 4471 0392", "周四例会 Zoom 会议号 812 4471 0392"],
      ["順豐運單 SF1428837761234 已發出", "顺丰运单 SF1428837761234 已发出"],
    ] as Array<[string, string]>) {
      expect(broadFoldReason(trad), trad).toBe(broadFoldReason(simp));
      expect(guardFoldReason(trad), trad).toBeNull();
      expect(directGuardLines(unitOf(trad)), trad).toEqual([]);
      expect(unitCarriesGuardedValue(unitOf(trad)), trad).toBe(false);
      expect(directUnitValueTokens(unitOf(trad)), trad).toEqual(directUnitValueTokens(unitOf(simp)));
    }
    expect(directUnitValueTokens(unitOf("酒店訂單號 HT20260912A8，9 月 12 日入住"))).toEqual([]);
  });

  it("finalizeAskAnswer：繁体凭据笔记的取值问被闭合；繁体订单号直答不误伤", () => {
    const secret = "門禁密碼（2046）";
    const su = unitOf(secret);
    const held = finalizeAskAnswer("門禁密碼是 2046 [1]", {
      dataText: secret,
      dataUnits: [su],
      question: "門禁密碼是多少？",
      tier: { kind: "single_note_direct", directUnit: su },
    });
    expect(held.answer).not.toContain("2046");

    const order = "酒店訂單號 HT20260912A8，9 月 12 日入住";
    const ou = unitOf(order);
    const direct = finalizeAskAnswer("酒店訂單號是 HT20260912A8 [1]", {
      dataText: order,
      dataUnits: [ou],
      question: "酒店訂單號是？",
      tier: { kind: "single_note_direct", directUnit: ou },
    });
    expect(direct.answer).toContain("HT20260912A8");
  });

  it("简体 / 非汉字笔记的判定不变（折叠对简体恒等）", () => {
    for (const t of ["家里路由器 WiFi 密码 sunny2026!home", "周三例会改到下午三点，会议室 B201", "Gmail: quiet.river.88 / Tq8#vL2m", "パスフレーズは やまざくら7823"]) {
      const u = unitOf(t);
      expect(directGuardLines(u).every((g) => t.includes(g.line)), t).toBe(true);
    }
    expect(unitCarriesGuardedValue(unitOf("家里路由器 WiFi 密码 sunny2026!home"))).toBe(true);
    expect(unitCarriesGuardedValue(unitOf("周三例会改到下午三点，会议室 B201"))).toBe(false);
  });
});
