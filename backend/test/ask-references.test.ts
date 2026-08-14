import { describe, it, expect } from "vitest";
import { reconcileAskCitations } from "../src/ask";

const ids = ["n1", "n2", "n3", "n4", "n5"];
const none = new Set<string>();

describe("reconcileAskCitations", () => {
  it("maps [n] citations to note ids, renumbered 1..k in citation order", () => {
    const { answer, references } = reconcileAskCitations("先看 [3]，再看 [1]，[3] 里也提到", ids, none);
    expect(answer).toBe("先看 [1]，再看 [2]，[1] 里也提到");
    expect(references).toEqual([
      { index: 1, note_id: "n3" },
      { index: 2, note_id: "n1" },
    ]);
  });

  it("normalizes full-width brackets", () => {
    const { answer, references } = reconcileAskCitations("见［2］", ids, none);
    expect(answer).toBe("见[1]");
    expect(references).toEqual([{ index: 1, note_id: "n2" }]);
  });

  it("strips out-of-range (hallucinated) citations from the text", () => {
    const { answer, references } = reconcileAskCitations("见 [7] 和 [2]", ids, none);
    expect(answer).toBe("见  和 [1]");
    expect(references).toEqual([{ index: 1, note_id: "n2" }]);
  });

  it("drops weak-source citations and removes their markers", () => {
    const { answer, references } = reconcileAskCitations("[1] 和 [2] 以及 [3]", ids, new Set(["n2"]));
    expect(answer).toBe("[1] 和  以及 [2]");
    expect(references).toEqual([
      { index: 1, note_id: "n1" },
      { index: 2, note_id: "n3" },
    ]);
  });

  it("keeps all citations rather than leaving an answer with zero references", () => {
    const { answer, references } = reconcileAskCitations("见 [1]", ids, new Set(["n1"]));
    expect(answer).toBe("见 [1]");
    expect(references).toEqual([{ index: 1, note_id: "n1" }]);
  });

  it("falls back to all recalled notes when nothing is cited", () => {
    const { answer, references } = reconcileAskCitations("没找到相关笔记。", ["a", "b"], none);
    expect(answer).toBe("没找到相关笔记。");
    expect(references).toEqual([
      { index: 1, note_id: "a" },
      { index: 2, note_id: "b" },
    ]);
  });

  it("fallback excludes weak-only sources", () => {
    const { references } = reconcileAskCitations("没找到。", ["a", "b"], new Set(["b"]));
    expect(references).toEqual([{ index: 1, note_id: "a" }]);
  });

  it("returns empty for empty recall", () => {
    expect(reconcileAskCitations("", [], none)).toEqual({ answer: "", references: [] });
  });

  it("every marker left in the answer has a matching reference card", () => {
    const { answer, references } = reconcileAskCitations("综合 [2][5]，另见 [9] 与 [4]", ids, new Set(["n5"]));
    const markers = [...answer.matchAll(/[\[［](\d{1,2})[\]］]/g)].map((m) => parseInt(m[1], 10));
    const refIndexes = references.map((r) => r.index);
    expect(new Set(markers)).toEqual(new Set(refIndexes));
  });
});

describe("cleanDanglingCitations via reconcileAskCitations (R116)", () => {
  it("cleans orphaned 和/以及 plus dangling 根据 after weak markers are removed", () => {
    const { answer } = reconcileAskCitations("根据 [1]、[2]、 和 [3]，你这个月花了 100 元", ["a", "b", "c"], new Set(["c"]));
    expect(answer).toBe("根据 [1]、[2]，你这个月花了 100 元");
  });
  it("repairs a citation verb stranded at the start after an out-of-range marker is stripped", () => {
    const { answer } = reconcileAskCitations("[7] 提到医生开的降压药", ["a"], new Set());
    expect(answer).toBe("笔记里提到医生开的降压药");
  });
  it("does not touch a normal 和 between words", () => {
    const { answer } = reconcileAskCitations("学了 C 和 G 和弦 [1]", ["a"], new Set());
    expect(answer).toBe("学了 C 和 G 和弦 [1]");
  });
});
