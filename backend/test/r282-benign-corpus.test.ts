// R282：能力识别内核对仓库权威 benign 语料（54 例）的误伤面必须为 0——
// 确定性层不得把合法技术/生活笔记判成危险执行或读者指令。
import { describe, it, expect } from "vitest";
import { BENIGN_CASES } from "../scripts/injection-eval-data";
import {
  hasExecIntentReason,
  normalizeCommandText,
  isolateNoteInstructions,
  dataTextHasIsolatableContent,
  splitSegmentsFenceAware,
  segmentIsReaderDirective,
} from "../src/prompt-armor";

describe("R282 benign 语料确定性层零误伤", () => {
  it("54 例 benign 笔记均不触发危险执行判定", () => {
    const hits: string[] = [];
    for (const b of BENIGN_CASES) {
      for (const line of b.note.split("\n")) {
        const r = hasExecIntentReason(normalizeCommandText(line));
        if (r) hits.push(`${b.id}: ${r} :: ${line}`);
      }
    }
    expect(hits).toEqual([]);
  });
  it("54 例 benign 笔记均不判为读者指令，且答案层原文投影不被隔离", () => {
    const bad: string[] = [];
    for (const b of BENIGN_CASES) {
      for (const seg of splitSegmentsFenceAware(b.note)) {
        if (!seg.text.startsWith("```") && segmentIsReaderDirective(seg.text)) bad.push(`${b.id}: ${seg.text}`);
      }
      if (dataTextHasIsolatableContent(b.note)) bad.push(`${b.id}: isolatable`);
      const projected = isolateNoteInstructions(b.note, b.question, b.note);
      if (projected !== b.note) bad.push(`${b.id}: projection changed`);
    }
    expect(bad).toEqual([]);
  });
});
