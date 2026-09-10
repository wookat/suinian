// R341（decision-r341）：报告行标题 / 线程摘要 / 复盘评语的模型视图补 ask 同款 fail-closed——
// 行级替换后按归一化比对复查，驻留形态（无 own 行，「宿舍柜子的锁改成了 0731」）整条只留占位。
// 语料：R336 + R340 全部安全 / 善意条目 + R335 盲测语料。
import { describe, it, expect } from "vitest";
import {
  redactGuardedViewForModel,
  redactGuardedLinesForModel,
  MODEL_REDACTED_LINE,
  stripInvisibleCarriers,
} from "../src/prompt-armor";
import { BENIGN as B36, SECURITY as S36 } from "../scripts/qa-r336/corpus";
import { BENIGN as B40, SECURITY as S40 } from "../scripts/qa-r340/corpus";
import { ALL_ATTACK, ALL_BENIGN } from "../scripts/qa-r335/blind-corpus.mjs";

type Attack = { id: string; notes: string[]; secret: string };
type Benign = { id: string; notes: string[] };

const fold = (s: string) => stripInvisibleCarriers(s).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
/** reports.modelRowTitle / threads / review 的调用形态：shown = title || content，unit = `${title}\n${content}` */
const view = (note: string) => redactGuardedViewForModel(note, `\n${note}`);

const SECURITY = [
  ...S36.map((c) => ({ id: c.id, note: c.note, secrets: c.secrets })),
  ...S40.map((c) => ({ id: c.id, note: c.note, secrets: c.secrets })),
  ...(ALL_ATTACK as Attack[]).flatMap((a) => a.notes.map((n, i) => ({ id: `r335:${a.id}#${i}`, note: n, secrets: [a.secret] }))),
];
const BENIGN_PLAIN = [...B36, ...B40].filter((b) => !b.boundary).map((b) => ({ id: b.id, note: b.note }));
/** R335 盲测善意里模型视图会被 fail-closed 整条扣的两条（与 ask 出口 modelContextNoteText 同一误伤集合，显式钉住防无声漂移）。 */
const R335_VIEW_BOUNDARY = new Set(["E13", "G17"]);
const BENIGN_R335 = (ALL_BENIGN as Benign[]).flatMap((b) => b.notes.map((n, i) => ({ id: b.id, idx: i, note: n })));

describe("R341 §2 驻留形态无 own 行：行级替换放过，视图层 fail-closed 拦下", () => {
  const note = "宿舍柜子的锁改成了 0731";
  it("redactGuardedLinesForModel 本身不替换（复现根因）", () => {
    const r = redactGuardedLinesForModel(note, `\n${note}`);
    expect(r.redacted).toBe(0);
    expect(r.text).toBe(note);
  });
  it("redactGuardedViewForModel 整条占位", () => {
    const v = view(note);
    expect(v.withheld).toBe(true);
    expect(v.redacted).toBe(1);
    expect(v.text).toBe(MODEL_REDACTED_LINE);
    expect(fold(v.text)).not.toContain("0731");
  });
  it("带标题的单元：标题作 shown、正文含驻留值 ⇒ 同样占位", () => {
    const v = redactGuardedViewForModel("宿舍柜子", `宿舍柜子\n${note}`);
    expect(v.withheld).toBe(false);
    expect(v.text).toBe("宿舍柜子");
    const v2 = redactGuardedViewForModel(`宿舍柜子\n${note}`, `宿舍柜子\n${note}`);
    expect(v2.withheld).toBe(true);
    expect(fold(v2.text)).not.toContain("0731");
  });
});

describe("R341 §4 三轮安全语料的模型视图零原值", () => {
  it(`安全 ${SECURITY.length} 条：视图不含任一原值`, () => {
    for (const c of SECURITY) {
      const v = view(c.note);
      for (const s of c.secrets) expect(fold(v.text), `${c.id} | ${c.note.slice(0, 40)}`).not.toContain(fold(s));
    }
  });
  it("own 行已替换的条目不因 fail-closed 改变结果（redacted 不多算）", () => {
    for (const c of SECURITY) {
      const lines = redactGuardedLinesForModel(c.note, `\n${c.note}`);
      const v = view(c.note);
      if (lines.text === MODEL_REDACTED_LINE) {
        expect(v.withheld, c.id).toBe(false);
        expect(v.redacted, c.id).toBe(lines.redacted);
      }
    }
  });
});

describe("R341 §4 善意语料的模型视图不占位", () => {
  it(`R336 + R340 普通善意 ${BENIGN_PLAIN.length} 条：视图即原文`, () => {
    for (const b of BENIGN_PLAIN) {
      const v = view(b.note);
      expect(v.withheld, b.id).toBe(false);
      expect(v.redacted, b.id).toBe(0);
      expect(v.text, b.id).toBe(b.note);
    }
  });
  it("R335 盲测善意：除 E13（账号：+ 汉语整句）/ G17（取件码，R336 §2.4 边界）外视图即原文；两条边界显式钉住", () => {
    for (const b of BENIGN_R335) {
      const v = view(b.note);
      if (R335_VIEW_BOUNDARY.has(b.id)) {
        expect(v.withheld, `${b.id}#${b.idx} 应为 fail-closed 边界`).toBe(true);
        continue;
      }
      expect(v.withheld, `${b.id}#${b.idx} | ${b.note.slice(0, 40)}`).toBe(false);
    }
  });
});
