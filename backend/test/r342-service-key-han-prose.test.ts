// R342（decision-r342）：「服务名：值」结构触发里，冒号后的纯汉字串以代词 / 虚词起头或超 12 字的是句子不是值——
// R335 E13「账号：我要把微博账号注销掉，太浪费时间」曾被当成 opaque 取值整单元扣留（ask 出口 + R341 模型视图同源误伤）。
import { describe, it, expect } from "vitest";
import {
  residencyTriggered,
  sourceValueCandidates,
  unitCarriesGuardedValue,
  redactGuardedViewForModel,
  MODEL_REDACTED_LINE,
} from "../src/prompt-armor";
import { modelContextNoteText } from "../src/ask-context";
import { ALL_ATTACK, ALL_BENIGN } from "../scripts/qa-r335/blind-corpus.mjs";
import { CARRIERS, SUPPLEMENT } from "../scripts/qa-r333/blind-corpus.mjs";
import { SECURITY as S36 } from "../scripts/qa-r336/corpus";
import { SECURITY as S40 } from "../scripts/qa-r340/corpus";

const cands = (u: string) => sourceValueCandidates([u]).map((c) => c.value);
const E13 = (ALL_BENIGN as { id: string; notes: string[] }[]).find((b) => b.id === "E13")!.notes[0];

describe("R342 §2 冒号后纯汉字句子不是服务键取值", () => {
  it("E13 原文：不触发驻留、无候选、不携守值", () => {
    expect(E13).toContain("账号");
    expect(residencyTriggered(E13)).toBe(false);
    expect(cands(E13)).toEqual([]);
    expect(unitCarriesGuardedValue(E13)).toBe(false);
  });
  it("E13 三处模型视图与 ask 模型上下文均为原文", () => {
    const v = redactGuardedViewForModel(E13, `\n${E13}`);
    expect(v.withheld).toBe(false);
    expect(v.text).toBe(E13);
    const ctx = modelContextNoteText({ title: null, content: E13, unit: `\n${E13}`, crossGuarded: new Set(), budget: 2000 });
    expect(ctx.text).not.toBe(MODEL_REDACTED_LINE);
    expect(ctx.text).toContain("注销");
  });
  it.each([
    "账号：这个月要把会员退了",
    "微博：不记得当时填的邮箱了",
    "支付宝：山有木兮木有枝心悦君兮君不知呀",
    "微信：视频会议",
  ])("句子 / 过长 / 过短纯汉字不成值：%s", (note) => {
    expect(residencyTriggered(note)).toBe(false);
    expect(cands(note)).toEqual([]);
  });
});

describe("R342 §3 6–12 字非句式纯汉字仍是服务键取值（不回退）", () => {
  it.each([
    ["微博：明月松间照清泉石上流", "明月松间照清泉石上流"],
    ["微信：青山不改绿水长流", "青山不改绿水长流"],
  ])("%s", (note, secret) => {
    expect(residencyTriggered(note)).toBe(true);
    expect(cands(note)).toContain(secret);
  });
  it("拉丁 / 混合值路径不变：Gmail: quiet.river.88", () => {
    expect(residencyTriggered("Gmail: quiet.river.88")).toBe(true);
    expect(cands("Gmail: quiet.river.88")).toContain("quiet.river.88");
  });
});

describe("R342 §3 四轮安全语料驻留判定不回退", () => {
  type Sec = { id: string; note: string; secrets: string[] };
  const rows: Sec[] = [
    ...S36.map((c) => ({ id: `r336:${c.id}`, note: c.note, secrets: c.secrets })),
    ...S40.map((c) => ({ id: `r340:${c.id}`, note: c.note, secrets: c.secrets })),
    ...(ALL_ATTACK as { id: string; notes: string[]; secret: string }[]).flatMap((a) => a.notes.map((n, i) => ({ id: `r335:${a.id}#${i}`, note: n, secrets: [a.secret] }))),
    ...(CARRIERS as { id: string; note: string; secrets: string[] }[]).map((c) => ({ id: `r333:${c.id}`, note: c.note, secrets: c.secrets })),
    ...(SUPPLEMENT as { id: string; note: string; secrets: string[] }[]).map((c) => ({ id: `r333:S${c.id}`, note: c.note, secrets: c.secrets })),
  ];
  it(`${rows.length} 条：单元含守值的仍含守值（纯汉字守值逐条在候选里）`, () => {
    for (const r of rows) {
      const inNote = r.secrets.filter((s) => r.note.normalize("NFKC").includes(s.normalize("NFKC")));
      if (inNote.length === 0) continue;
      expect(unitCarriesGuardedValue(r.note), `${r.id} | ${r.note.slice(0, 40)}`).toBe(true);
      for (const s of inNote) {
        if (!/^\p{Script=Han}+$/u.test(s)) continue;
        expect(cands(r.note), `${r.id} 纯汉字守值 ${s}`).toContain(s);
      }
    }
  });
});
