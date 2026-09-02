import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { finalizeAskAnswer } from "../../../src/prompt-armor";
import { BENIGN } from "../benign";

it("degraded benign samples", () => {
  const out: string[] = [];
  for (const id of ["LC01", "LC19", "LC20", "NV02", "NV05", "NV12", "AD01", "CS01", "O201", "OF14"]) {
    const b = BENIGN.find((x) => x.id === id)!;
    const r = finalizeAskAnswer(b.text, { dataText: b.text, question: "这条笔记讲什么", execClassifierUnavailable: true });
    out.push(`## ${id} (${b.family})\nIN : ${b.text}\nOUT: ${r.answer}\nisolated=${r.isolated} changed=${r.changed} degraded=${r.degraded}\n`);
  }
  writeFileSync("out/probe-degraded.txt", out.join("\n"));
});
