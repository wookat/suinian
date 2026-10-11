import { describe, expect, it } from "vitest";
import {
  conceptualLabelFree,
  isSecretValueQuestion,
  residencyTriggered,
  unitCarriesGuardedValue,
  broadFoldReason,
} from "../src/prompt-armor";

/**
 * R343（decision-r343）：R340 §3.3 把「锁」加进概念后缀后，「密码锁」在问句里被整词抹掉，
 * 「行李箱密码锁的数字是多少」失去锁具称谓 → 不再是取值问（同义的「行李箱锁是几」却是）。
 * 修法：概念后缀为「锁」时只抹称谓词、保留「锁」，交给 RESIDENCY_QUESTION_LABEL_RE + LOCK_OBJECT_TALK_RE 同口径判。
 */
describe("R343 锁具取值问：「密码锁」抹称谓不抹「锁」", () => {
  it("conceptualLabelFree 保留「锁」，其余概念后缀仍整词抹掉", () => {
    expect(conceptualLabelFree("行李箱密码锁的数字是多少")).toBe("行李箱 锁的数字是多少");
    expect(conceptualLabelFree("密码学课笔记")).not.toMatch(/密码|锁/u);
    expect(conceptualLabelFree("密码长度要求")).not.toMatch(/密码|锁/u);
  });

  it("锁具取值问与「行李箱锁是几」同口径：是取值问", () => {
    for (const q of [
      "行李箱密码锁的数字是多少",
      "密码锁的数字是多少",
      "行李箱密码锁是几",
      "储物柜密码锁设的几位数是啥",
      "密码锁的组合是多少",
      "行李箱锁是几",
      "密码锁密码多少",
    ]) expect(isSecretValueQuestion(q), q).toBe(true);
  });

  it("谈论锁具本身（价钱 / 牌子 / 型号 / 坏了 / 钥匙 / 改密码流程）不是取值问（R340 Y05 / Z 族不回退）", () => {
    for (const q of [
      "行李箱密码锁多少钱",
      "密码锁什么牌子",
      "那把密码锁什么型号",
      "密码锁坏了怎么办",
      "密码锁的钥匙在哪",
      "密码锁怎么改密码",
    ]) expect(isSecretValueQuestion(q), q).toBe(false);
  });

  it("笔记侧判定不变：有值面的密码锁笔记仍受守，价钱 / 换锁散文不受守", () => {
    for (const n of ["行李箱密码锁 0-7-3", "行李箱密码锁 4471", "行李箱的密码锁设成了 2046"]) {
      expect(residencyTriggered(n), n).toBe(true);
      expect(unitCarriesGuardedValue(n), n).toBe(true);
      expect(broadFoldReason(n), n).not.toBeNull();
    }
    for (const n of ["买了一把密码锁 89 元，装在储物间门上", "密码锁换了个新的，旧的钥匙丢了", "密码锁一般 3 位转盘"]) {
      expect(residencyTriggered(n), n).toBe(false);
      expect(unitCarriesGuardedValue(n), n).toBe(false);
      expect(broadFoldReason(n), n).toBeNull();
    }
  });
});
