// R337（decision-r337）：「普通事实 + 凭据取值」复合问句的确定性拆句 + 两段合并。
// §4 拆句不含任何 LLM 环节；全普通 / 全凭据 / 带候选值 / 是非问 / 逐位试探一律不拆（行为与现状一致）；
// §4 合并：普通段引用编号不动、凭据段顺延并复用同笔记编号，计数句按合并引用重算，合并体不二次收口。
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/ai", () => ({ chatComplete: async () => null }));
vi.mock("../src/semantic", () => ({
  embedText: async () => null,
  semanticRecall: async () => [],
  cosineSim: () => 0,
  noteHasSemanticSignal: () => true,
}));

import { splitCompoundQuestion, isSecretValueQuestion, isOracleProbeQuestion, ORACLE_NEUTRAL_NOTICE } from "../src/prompt-armor";
import { mergeAskCompoundParts, GUARDED_CARD_PLACEHOLDER } from "../src/index";
import { FOLDED_REF_COUNT_RE, foldedRefCountLine, sensitiveOnlyAnswer, SENSITIVE_CARD_PLACEHOLDER } from "../src/sensitive-recall";
import { COMPOUND } from "../scripts/qa-r337/corpus";

describe("R337 §4 splitCompoundQuestion：族外语料（scripts/qa-r337/corpus.ts）", () => {
  for (const c of COMPOUND) {
    it(`${c.id} ${c.question}`, () => {
      const split = splitCompoundQuestion(c.question);
      if (c.expect === null) {
        expect(split).toBeNull();
      } else {
        expect(split).not.toBeNull();
        expect(split!.guarded).toHaveLength(c.expect.guarded);
        expect(split!.plain).toHaveLength(c.expect.plain);
      }
    });
  }

  it("拆出的每个凭据子句单独看仍是取值 / 预言机问，每个普通子句单独看都不是", () => {
    for (const c of COMPOUND) {
      const split = splitCompoundQuestion(c.question);
      if (!split) continue;
      for (const g of split.guarded) {
        const q = /什么|啥|多少|哪|几|吗|呢/.test(g) ? g : `${g}是什么`;
        expect(isSecretValueQuestion(q) || isOracleProbeQuestion(q, { anchored: true }), `${c.id} guarded «${g}»`).toBe(true);
      }
      for (const p of split.plain) {
        const q = /什么|啥|多少|哪|几|吗|呢/.test(p) ? p : `${p}是什么`;
        expect(isSecretValueQuestion(q) || isOracleProbeQuestion(q, { anchored: true }), `${c.id} plain «${p}»`).toBe(false);
      }
    }
  });

  it("共享谓语「分别是什么」分配到无谓语的普通子句（P03），并列副词「分别」不进任一子句", () => {
    const split = splitCompoundQuestion("健身房年卡到期日和储物柜密码分别是什么");
    expect(split).toEqual({ guarded: ["储物柜密码是什么"], plain: ["健身房年卡到期日是什么"] });
    // 普通子句在句尾时同样剥掉「分别」：单主语子句不该被「分别是什么」的逐位枚举形态改判成预言机
    expect(splitCompoundQuestion("储物柜密码和健身房年卡到期日分别是什么")).toEqual({
      guarded: ["储物柜密码是什么"],
      plain: ["健身房年卡到期日是什么"],
    });
    expect(splitCompoundQuestion("Wi-Fi 密码和航班号各是多少？")).toEqual({ guarded: ["Wi-Fi 密码是多少"], plain: ["航班号是多少"] });
    const plainLast = splitCompoundQuestion("Wi-Fi 密码和航班号分别是什么");
    expect(plainLast?.plain).toEqual(["航班号是什么"]);
    expect(isOracleProbeQuestion("航班号分别是什么")).toBe(true);
    expect(isOracleProbeQuestion(plainLast!.plain[0])).toBe(false);
  });

  it("带候选值 / 是非问 / 逐位试探形态不拆（预言机差分面不变）", () => {
    expect(splitCompoundQuestion("航班号是多少，Wi-Fi 密码是 Rt5&yy8q 吗")).toBeNull();
    expect(splitCompoundQuestion("航班号是多少，门禁密码是不是 4821")).toBeNull();
    expect(splitCompoundQuestion("航班号和 Wi-Fi 密码的第 3 位分别是什么")).toBeNull();
    expect(splitCompoundQuestion("航班号和口令的每个字分别是什么")).toBeNull();
  });

  it("子句话题词不足 2 字（代词 / 序数指代）不拆，交由整句路径按历史解析", () => {
    expect(splitCompoundQuestion("那个和这个分别是什么")).toBeNull();
    expect(splitCompoundQuestion("第 1 个和第 2 个分别是什么")).toBeNull();
    expect(splitCompoundQuestion("航班号和它分别是什么")).toBeNull();
  });

  it("超过 3 个子句不拆（复杂并列回落整句路径）", () => {
    expect(splitCompoundQuestion("航班号是多少、登机口在哪、酒店地址是什么、Wi-Fi 密码是多少")).toBeNull();
  });

  it("历史上文里的凭据锚不会把普通子句判成凭据子句（子句自身无称谓）", () => {
    const hist = "用户：Wi-Fi 密码是什么\n助手：〔中性提示〕";
    const split = splitCompoundQuestion("航班号是多少，还有门禁密码是几", hist);
    expect(split).toEqual({ guarded: ["门禁密码是几"], plain: ["航班号是多少"] });
  });
});

type Part = Parameters<typeof mergeAskCompoundParts>[0];
const plainPart = (): Part => ({
  answer: "航班号是 CA1831，10 月 3 日 08:20 起飞[1]。",
  references: [{ index: 1, note_id: "n-flight" }],
  notes: [{ id: "n-flight", content: "国庆回家：CA1831 10-03 08:20 起飞", content_withheld: false }],
  trust_tier: "single_note",
  verbatim_closed_spans: 0,
});
const guardedPart = (): Part => ({
  answer: `${ORACLE_NEUTRAL_NOTICE}[1]\n\n${foldedRefCountLine([{ index: 1 }])}`,
  references: [{ index: 1, note_id: "n-wifi" }],
  notes: [{ id: "n-wifi", content: GUARDED_CARD_PLACEHOLDER, content_withheld: true, guarded: true }],
  value_withheld: true,
  oracle_neutral: true,
  trust_tier: "aggregate",
  verbatim_closed_spans: 0,
});

describe("R337 §4 mergeAskCompoundParts", () => {
  it("普通段答案在前、编号不动；凭据段角标顺延；计数句只有一句且指向顺延后的折叠卡", () => {
    const out = mergeAskCompoundParts(plainPart(), guardedPart(), { plain: 1, guarded: 1 });
    expect(out.answer.startsWith("航班号是 CA1831，10 月 3 日 08:20 起飞[1]。")).toBe(true);
    expect(out.answer).toContain(`${ORACLE_NEUTRAL_NOTICE}[2]`);
    expect(out.answer.match(FOLDED_REF_COUNT_RE)?.length ?? 0).toBe(1);
    expect(out.answer).toContain(foldedRefCountLine([{ index: 2 }]));
    expect(out.references).toEqual([
      { index: 1, note_id: "n-flight" },
      { index: 2, note_id: "n-wifi" },
    ]);
    expect(out.notes).toHaveLength(2);
    expect(out.notes[1].content_withheld).toBe(true);
    expect(out.notes[1].content).toBe(GUARDED_CARD_PLACEHOLDER);
  });

  it("安全字段取并：value_withheld / oracle_neutral 来自凭据段；合并体标 guard_finalized（两段已各自过唯一安全出口）", () => {
    const out = mergeAskCompoundParts(plainPart(), guardedPart(), { plain: 1, guarded: 1 });
    expect(out.value_withheld).toBe(true);
    expect(out.oracle_neutral).toBe(true);
    expect(out.guard_finalized).toBe(true);
    expect(out.no_answer).toBe(false);
    expect(out.compound_split).toEqual({ plain: 1, guarded: 1 });
  });

  it("同一笔记两段都引到：复用普通段编号、不重复出卡；任一段折叠即取折叠卡（fail-closed）", () => {
    const plain = plainPart();
    plain.references.push({ index: 2, note_id: "n-router" });
    plain.notes.push({ id: "n-router", content: "路由器在客厅电视柜后面", content_withheld: false });
    const guarded = guardedPart();
    guarded.answer = `${ORACLE_NEUTRAL_NOTICE}[1][2]`;
    guarded.references.push({ index: 2, note_id: "n-router" });
    guarded.notes.push({ id: "n-router", content: GUARDED_CARD_PLACEHOLDER, content_withheld: true, guarded: true });
    const out = mergeAskCompoundParts(plain, guarded, { plain: 1, guarded: 1 });
    expect(out.references).toEqual([
      { index: 1, note_id: "n-flight" },
      { index: 2, note_id: "n-router" },
      { index: 3, note_id: "n-wifi" },
    ]);
    expect(out.notes).toHaveLength(3);
    expect(out.notes[1].content_withheld).toBe(true);
    expect(out.notes[1].content).toBe(GUARDED_CARD_PLACEHOLDER);
    expect(out.answer).toContain(`${ORACLE_NEUTRAL_NOTICE}[3][2]`);
    expect(out.answer).toContain(foldedRefCountLine([{ index: 2 }, { index: 3 }]));
  });

  it("凭据段是纯敏感卡计数句（sensitiveOnlyAnswer）时：去旧计数句，按合并引用重算一句", () => {
    const guarded = guardedPart();
    guarded.answer = sensitiveOnlyAnswer(1, [{ index: 1 }]);
    guarded.notes = [{ id: "n-wifi", content: SENSITIVE_CARD_PLACEHOLDER, content_withheld: true, is_sensitive: true }];
    const out = mergeAskCompoundParts(plainPart(), guarded, { plain: 1, guarded: 1 });
    expect(out.answer).not.toContain("有 1 条敏感笔记可能相关");
    expect(out.answer.match(FOLDED_REF_COUNT_RE)?.length ?? 0).toBe(1);
    expect(out.answer).toContain(foldedRefCountLine([{ index: 2 }]));
    expect(out.answer).not.toMatch(/[[［]1[\]］][^\n]*$/);
  });

  it("两段都「没找到」才是 no_answer；普通段没找到而凭据段有折叠卡时普通段提示保留在前", () => {
    const plain = plainPart();
    plain.answer = "没找到相关笔记。";
    plain.references = [];
    plain.notes = [];
    plain.no_answer = true;
    const out = mergeAskCompoundParts(plain, guardedPart(), { plain: 1, guarded: 1 });
    expect(out.no_answer).toBe(false);
    expect(out.answer.startsWith("没找到相关笔记。")).toBe(true);
    expect(out.references).toEqual([{ index: 1, note_id: "n-wifi" }]);
    expect(out.answer).toContain(`${ORACLE_NEUTRAL_NOTICE}[1]`);
    const g = guardedPart();
    g.answer = "没找到相关笔记。";
    g.references = [];
    g.notes = [];
    g.no_answer = true;
    expect(mergeAskCompoundParts(plain, g, { plain: 1, guarded: 1 }).no_answer).toBe(true);
  });

  it("指令隔离字段随凭据段透传：instruction_isolated 取并，isolated_refs 按顺延后的编号重映射并与普通段去重", () => {
    const plain = plainPart();
    plain.isolated_refs = [1];
    const guarded = guardedPart();
    guarded.instruction_isolated = true;
    guarded.isolated_refs = [1];
    const out = mergeAskCompoundParts(plain, guarded, { plain: 1, guarded: 1 });
    expect(out.instruction_isolated).toBe(true);
    expect(out.isolated_refs).toEqual([1, 2]);
    const none = mergeAskCompoundParts(plainPart(), guardedPart(), { plain: 1, guarded: 1 });
    expect(none.instruction_isolated).toBeUndefined();
    expect(none.isolated_refs).toBeUndefined();
  });

  it("合并不把凭据段的占位卡原文替换成普通段任何内容（notes[] 折叠卡不回传原文）", () => {
    const out = mergeAskCompoundParts(plainPart(), guardedPart(), { plain: 1, guarded: 1 });
    for (const n of out.notes) {
      if (n.content_withheld === true) expect([GUARDED_CARD_PLACEHOLDER, SENSITIVE_CARD_PLACEHOLDER]).toContain(n.content);
    }
  });
});
