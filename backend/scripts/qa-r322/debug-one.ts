/** R322 本地调试：按 id 打印单条载体的 finalizeAskAnswer 归因。用法：npx tsx scripts/qa-r322/debug-one.ts IB05 GB43 */
import { ALL as BLIND_ALL } from "../qa-r321/blind-carriers";
import { ALL as INFORMED_ALL } from "../qa-r321/informed-carriers";
import { R322_CARRIERS } from "./carriers";
import { directGuardLines, finalizeAskAnswer, redactGuardedLinesForModel } from "../../src/prompt-armor";

type C = { id: string; texts: string[]; answer: string; needles: string[]; cat: string; ask: string; tier?: string };
const all: C[] = [...(BLIND_ALL as C[]), ...(INFORMED_ALL as C[]), ...(R322_CARRIERS as C[])];
for (const id of process.argv.slice(2)) {
  const c = all.find((x) => x.id === id);
  if (!c) {
    console.log(`${id}: not found`);
    continue;
  }
  const units = c.texts;
  const fin = finalizeAskAnswer(c.answer, {
    dataText: units.join("\n"),
    dataUnits: units,
    question: c.ask,
    verbatimExempt: c.ask,
    tier: units.length === 1 ? { kind: "single_note_direct", directUnit: units[0] } : { kind: "aggregate" },
  });
  console.log(JSON.stringify({ id, ask: c.ask, guards: units.map((u) => directGuardLines(u)), redacted: units.map((u) => redactGuardedLinesForModel(u)), answer: c.answer, out: fin }, null, 1));
}
