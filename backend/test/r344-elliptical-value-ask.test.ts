import { describe, expect, it } from "vitest";
import {
  broadFoldReason,
  isOracleProbeQuestion,
  isSecretValueQuestion,
  residencyTriggered,
  unitCarriesGuardedValue,
} from "../src/prompt-armor";

// R344：省略句取值问（「wifi 密码呢」）、设备动作 + 几（「密码盘转到几」）、「密码箱」实物称谓——decision-r344。
describe("R344 省略句取值问：只有凭证称谓收尾的名词短语就是在问值", () => {
  it("称谓收尾 + 可选语气词 / 标点 ⇒ 取值问", () => {
    for (const q of [
      "wifi密码呢",
      "wifi 密码",
      "家里wifi的密码",
      "那个箱子的密码",
      "储物柜密码？",
      "保险柜的密码。",
      "密码锁的密码呢",
      "改后的密码",
      "笔记里的wifi密码",
      "wifi password?",
    ]) expect(isSecretValueQuestion(q), q).toBe(true);
  });

  it("动作 / 方式 / 位置 / 概念 / 状态词在句里 ⇒ 不是取值问（不因称谓收尾就守）", () => {
    for (const q of [
      "改密码",
      "怎么改密码",
      "怎么设wifi密码",
      "wifi密码怎么改",
      "记一下wifi密码",
      "密码在哪",
      "密码学",
      "密码管理",
      "密码策略",
      "密码过期了",
      "密码错误",
      "how to change wifi password",
      "password manager",
      "password policy",
      "VPN 口令忘了怎么办？",
      "我什么时候改的密码",
      "为什么要换密码",
    ]) expect(isSecretValueQuestion(q), q).toBe(false);
  });

  it("普通识别符 / 家电名词收尾不是凭证称谓：不守", () => {
    for (const q of ["我的航班号", "取件码", "快递单号", "身份证号", "银行卡号", "邮箱是多少", "冰箱是几度"]) {
      expect(isSecretValueQuestion(q), q).toBe(false);
    }
  });
});

describe("R344 设备动作 + 几：转到 / 拨到 / 按 / 输 / 设 几 是取值问", () => {
  it("有凭证 / 驻留称谓时是取值问", () => {
    for (const q of ["密码盘转到几", "密码盘拨到几", "密码键盘按几", "门禁要按几", "储物柜锁拨几", "密码箱设的是几"]) {
      expect(isSecretValueQuestion(q), q).toBe(true);
    }
  });

  it("几 + 量词（下 / 楼 / 次 / 圈）不是取值", () => {
    for (const q of ["密码锁转几下", "电梯按几楼", "密码盘转几圈"]) expect(isSecretValueQuestion(q), q).toBe(false);
  });
});

describe("R344 「密码箱」与「密码锁」同口径：抹称谓保留实物名", () => {
  it("密码箱的取值问是取值问；尺寸 / 价钱 / 颜色是谈论实物", () => {
    for (const q of ["密码箱的数字是几", "行李箱密码箱是几", "密码箱的密码是多少"]) {
      expect(isSecretValueQuestion(q), q).toBe(true);
    }
    for (const q of ["密码箱多大？", "密码箱多少寸", "密码箱多少钱", "密码箱什么颜色", "密码箱什么牌子"]) {
      expect(isSecretValueQuestion(q), q).toBe(false);
    }
    // 「密码箱的数字是几」形态同时命中预言机；不能变成 false
    expect(isOracleProbeQuestion("密码箱的数字是几")).toBe(true);
  });

  it("笔记侧判定不变：有值面的密码箱笔记仍受守，价钱 / 尺寸散文不受守", () => {
    // 「密码箱 4471」走凭证称谓 + 值面（structuralValueFace 保留整行），与 R343 前后一致；「保险箱 4471」走驻留
    for (const n of ["密码箱 4471", "行李箱的密码箱设成了 2046", "保险箱 4471"]) {
      expect(unitCarriesGuardedValue(n), n).toBe(true);
      expect(broadFoldReason(n), n).not.toBeNull();
    }
    for (const n of ["买了个 20 寸密码箱 899 元", "密码箱换了个新的，旧的钥匙丢了"]) {
      expect(residencyTriggered(n), n).toBe(false);
      expect(unitCarriesGuardedValue(n), n).toBe(false);
      expect(broadFoldReason(n), n).toBeNull();
    }
  });
});
