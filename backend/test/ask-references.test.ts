import { describe, it, expect } from "vitest";
import { buildAskReferences } from "../src/index";

const ids = ["n1", "n2", "n3", "n4", "n5"];

describe("buildAskReferences", () => {
  it("maps [n] citations to note ids with matching index, in citation order", () => {
    const refs = buildAskReferences("先看 [3]，再看 [1]，[3] 里也提到", ids);
    expect(refs).toEqual([
      { index: 3, note_id: "n3" },
      { index: 1, note_id: "n1" },
    ]);
  });

  it("supports full-width brackets", () => {
    expect(buildAskReferences("见［2］", ids)).toEqual([{ index: 2, note_id: "n2" }]);
  });

  it("ignores out-of-range citations", () => {
    const refs = buildAskReferences("见 [7] 和 [2]", ids);
    expect(refs).toEqual([{ index: 2, note_id: "n2" }]);
  });

  it("falls back to all recalled notes with prompt indexes when nothing is cited", () => {
    const refs = buildAskReferences("没找到相关笔记。", ["a", "b"]);
    expect(refs).toEqual([
      { index: 1, note_id: "a" },
      { index: 2, note_id: "b" },
    ]);
  });

  it("returns empty for empty recall", () => {
    expect(buildAskReferences("", [])).toEqual([]);
  });
});
