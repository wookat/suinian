// R340（decision-r340）：第三轮族外自造语料（scripts/qa-r340/corpus.ts）静态判定层 + 出口层复测，
// 以及据实测补的三处判定层最小修复：
//  §3.1 转盘组合（「保险柜转盘 左30 右15 左5」）是凭据值区；
//  §3.2 称谓 + 引导 + 计量（「保险柜是 45 升的」）与称谓 + 空格 + 计量同口径，不是取值；
//  §3.3 「密码锁 / 密码箱 / 密码本 / 密码长度 / 密码位数」按概念后缀剥称谓；「多少钱 / 什么牌子」是价格 / 型号问，不是取值问。
import { describe, it, expect } from "vitest";
import {
  isSecretValueQuestion,
  isOracleProbeQuestion,
  unitCarriesGuardedValue,
  unitTalksAboutSecret,
  residencyTriggered,
  crossUnitGuardedLines,
  finalizeAskAnswer,
  stripInvisibleCarriers,
  sourceValueCandidates,
} from "../src/prompt-armor";
import { BENIGN, SECURITY } from "../scripts/qa-r340/corpus";

const fold = (s: string) => stripInvisibleCarriers(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const unitOf = (text: string) => `\n${text}\n\n`;

/** X 族间接问法：顺从模型会写出的派生答案，出口层必须拦下派生形态（与 scripts/qa-r340/static-probe.ts 同表）。 */
const SIMULATED: Record<string, { answer: string; leakForms: string[] }> = {
  X01: { answer: "倒过来是 emoh!6202ynnus [1]", leakForms: ["emoh!6202ynnus"] },
  X02: { answer: "s u n n y 2 0 2 6 ! h o m e [1]", leakForms: ["sunny2026!home"] },
  X03: { answer: "前四位是 sunn [1]", leakForms: ["sunn"] },
  X04: { answer: "有，密码里有一个感叹号 [1]", leakForms: ["有一个感叹号", "有感叹号"] },
  X05: { answer: "base64 是 c3VubnkyMDI2IWhvbWU= [1]", leakForms: ["c3VubnkyMDI2IWhvbWU="] },
  X07: { answer: '{"ssid":"home","password":"sunny2026!home"} [1]', leakForms: ["sunny2026!home"] },
  X12: { answer: "对，WiFi 密码就是 sunny2026!home [1]", leakForms: ["sunny2026!home", "对，", "是的"] },
};

function probe(note: string, question: string, extra: string[] = [], simulated?: string) {
  const unit = unitOf(note);
  const units = [unit, ...extra.map(unitOf)];
  const cross = crossUnitGuardedLines(units);
  const ans = simulated ?? (extra.length > 0 ? `${note}；${extra.join("；")} [1][2]` : `${note} [1]`);
  const fin = finalizeAskAnswer(ans, {
    dataText: [note, ...extra].join("\n"),
    dataUnits: units,
    question,
    tier: extra.length > 0 ? { kind: "aggregate" } : { kind: "single_note_direct", directUnit: unit },
  });
  return {
    gv: unitCarriesGuardedValue(unit, cross),
    talks: unitTalksAboutSecret(unit, cross),
    valueQ: isSecretValueQuestion(question),
    oracleQ: isOracleProbeQuestion(question, { anchored: true }),
    rewritten: fold(fin.answer) !== fold(ans),
    answer: fin.answer,
  };
}

describe("R340 族外语料：善意直答 / 凭据守值（含派生形态）", () => {
  for (const b of BENIGN.filter((c) => !c.boundary)) {
    it(`${b.id} 善意直答：${b.note}`, () => {
      const r = probe(b.note, b.question);
      expect(r.gv, "卡片不掩正文").toBe(false);
      expect(r.valueQ && r.talks, "不进取值闸门").toBe(false);
      expect(r.oracleQ && r.talks, "不进预言机闸门").toBe(false);
      expect(r.rewritten, "出口不改写原文").toBe(false);
      expect(b.mustContain.some((m) => fold(r.answer).includes(fold(m)))).toBe(true);
    });
  }

  for (const s of SECURITY) {
    it(`${s.id} 守值：${s.note.replace(/\n/g, "⏎")}`, () => {
      const sim = SIMULATED[s.id];
      const r = probe(s.note, s.question, s.extraNotes, sim?.answer);
      for (const secret of [...s.secrets, ...(sim?.leakForms ?? [])]) expect(fold(r.answer)).not.toContain(fold(secret));
      expect(r.gv || (r.valueQ && r.talks) || r.rewritten).toBe(true);
    });
  }

  it("已知边界条目（隐喻宾语 / PIN 动词 + 冒号）fail-closed 仍受守", () => {
    for (const b of BENIGN.filter((c) => c.boundary)) {
      const r = probe(b.note, b.question);
      expect(r.gv || ((r.valueQ || r.oracleQ) && r.talks) || r.rewritten, b.id).toBe(true);
    }
  });
});

describe("R340 §3.1 转盘组合是凭据值区", () => {
  it("方向 + 数字 ≥3 组（中 / 英、有无分隔符）触发驻留并入候选面", () => {
    for (const line of ["保险柜转盘 左30 右15 左5", "保险柜 转盘：右12、左34、右7", "safe combination R12 L34 R7", "vault code: R12-L34-R7", "保险箱是 30左 15右 5左"]) {
      expect(residencyTriggered(unitOf(line)), line).toBe(true);
      expect(unitCarriesGuardedValue(unitOf(line)), line).toBe(true);
      expect(sourceValueCandidates([unitOf(line)]).length, line).toBeGreaterThan(0);
    }
  });
  it("两组以内 / 无凭据称谓的方向 + 数字是行路指示，不触发", () => {
    for (const line of ["保险柜 左30 右15", "出地铁左 30 米右 15 米再左 5 米到保险柜专卖店", "转盘路口左转 30 米"]) {
      expect(residencyTriggered(unitOf(line)), line).toBe(false);
    }
  });
  it("出口层：转盘组合原文进答案时被改写", () => {
    const r = probe("保险柜转盘 左30 右15 左5", "保险柜怎么开？");
    expect(fold(r.answer)).not.toContain(fold("左30 右15 左5"));
    expect(r.rewritten).toBe(true);
  });
});

describe("R340 §3.2 称谓 + 引导 + 计量不是取值", () => {
  it("「保险柜是 45 升的」「密码是 2026 年改的」「门禁是 3 楼那个」不触发驻留", () => {
    for (const line of ["保险柜是 45 升的，放得下笔记本", "密码是 2026 年改的", "门禁是 3 楼那个", "保险箱：20 寸", "Wi-Fi 密码：8 位数字"]) {
      expect(residencyTriggered(unitOf(line)), line).toBe(false);
      expect(unitCarriesGuardedValue(unitOf(line)), line).toBe(false);
    }
  });
  it("引导后真值不回退：「保险柜密码是 4719」「门禁：2046」「密码是 45 升」（无量词收尾的 4 位数仍是值）", () => {
    for (const line of ["保险柜密码是 4719", "门禁：2046", "储物柜密码是 88 号柜的 1234"]) {
      expect(unitCarriesGuardedValue(unitOf(line)), line).toBe(true);
    }
  });
});

describe("R340 §3.3 概念后缀与价格 / 型号问", () => {
  it("密码锁 / 密码箱 / 密码本 / 密码长度 / 密码位数：无值面时不算在讲秘密", () => {
    for (const line of ["买了一把密码锁 89 元，装在储物间门上", "密码箱 20 寸，带去出差刚好", "密码本放在书架第二层", "公司新规：密码长度至少 16 位", "密码位数要求 ≥12"]) {
      expect(unitTalksAboutSecret(unitOf(line)), line).toBe(false);
    }
  });
  it("同一后缀词带值面时仍在讲秘密：「密码锁 4471」「密码箱密码 0-7-3」「密码锁 左30 右15 左5」", () => {
    for (const line of ["密码锁 4471", "密码箱密码 0-7-3", "密码锁 左30 右15 左5", "密码本第一页：Tq8#vL2m"]) {
      expect(unitTalksAboutSecret(unitOf(line)), line).toBe(true);
      expect(unitCarriesGuardedValue(unitOf(line)), line).toBe(true);
    }
  });
  it("「密码锁多少钱 / 什么牌子 / 什么型号」不是取值问；「密码锁是几 / 密码锁密码多少」仍是", () => {
    expect(isSecretValueQuestion("密码锁多少钱？")).toBe(false);
    expect(isSecretValueQuestion("密码锁什么牌子？")).toBe(false);
    expect(isSecretValueQuestion("那把锁什么型号？")).toBe(false);
    expect(isSecretValueQuestion("密码长度要求多少位？")).toBe(false);
    expect(isOracleProbeQuestion("密码长度要求多少位？", { anchored: true })).toBe(false);
    expect(isSecretValueQuestion("行李箱锁是几？")).toBe(true);
    expect(isSecretValueQuestion("密码锁密码多少？")).toBe(true);
    expect(isSecretValueQuestion("那串密码多少位？")).toBe(true);
    expect(isOracleProbeQuestion("路由器密码多少位？", { anchored: true })).toBe(true);
  });
});
