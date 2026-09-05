/**
 * R322 本地探针：R321 盲测 / 知情语料逐条过受守判据 + 出口闭合上界（模型如实复述的最坏 answer）。
 * 用法：npx tsx scripts/qa-r322/probe-guard.ts
 */
import { ALL as BLIND_ALL } from "../qa-r321/blind-carriers";
import { ALL as INFORMED_ALL } from "../qa-r321/informed-carriers";
import { R322_CARRIERS } from "./carriers";
import {
  directGuardLines,
  finalizeAskAnswer,
  redactGuardedLinesForModel,
  crossUnitGuardedLines,
  normalizeForLeakCompare,
  DIRECT_GUARD_PLACEHOLDER_RE,
  ORACLE_NEUTRAL_NOTICE,
} from "../../src/prompt-armor";

type C = { id: string; texts: string[]; answer: string; needles: string[]; cat: string; ask: string; tier?: string };
const all: C[] = [...(BLIND_ALL as C[]), ...(INFORMED_ALL as C[]), ...(R322_CARRIERS as C[])];

let dangerLeak = 0;
let dangerUnguarded = 0;
let benignGuarded = 0;
let benignTotal = 0;
let dangerTotal = 0;
for (const c of all) {
  const units = c.texts;
  const cross = crossUnitGuardedLines(units);
  const guarded = units.map((u) => directGuardLines(u));
  const anyGuard = guarded.some((g) => g.length > 0) || cross.size > 0;
  const redacted = units.map((u) => redactGuardedLinesForModel(u, undefined, cross).text);
  const direct = units[0];
  const fin = finalizeAskAnswer(c.answer, {
    dataText: units.join("\n"),
    dataUnits: units,
    question: c.ask,
    verbatimExempt: c.ask,
    tier: units.length === 1 ? { kind: "single_note_direct", directUnit: direct } : { kind: "aggregate" },
  });
  const normAns = normalizeForLeakCompare(fin.answer);
  const leaked = c.needles.filter((n) => {
    const nn = normalizeForLeakCompare(n);
    return (nn.length > 0 && normAns.includes(nn)) || fin.answer.includes(n);
  });
  const ctxLeak = c.needles.filter((n) => redacted.some((r) => normalizeForLeakCompare(r).includes(normalizeForLeakCompare(n))));
  if (c.cat === "danger") {
    dangerTotal += 1;
    if (!anyGuard) dangerUnguarded += 1;
    if (leaked.length > 0) dangerLeak += 1;
    const flag = leaked.length > 0 ? "LEAK" : !anyGuard ? "unguarded" : ctxLeak.length > 0 ? "ctx-leak" : "ok";
    if (flag !== "ok") console.log(`${c.id} danger ${flag} kinds=${guarded.map((g) => g.map((x) => `${x.kind}${x.own ? "" : "*"}`).join(",") || "-").join(" | ")} leaked=${JSON.stringify(leaked)} ctx=${JSON.stringify(ctxLeak)}\n   answer=${fin.answer.replace(/\n/g, " ⏎ ")}`);
  } else {
    benignTotal += 1;
    const placeholder = DIRECT_GUARD_PLACEHOLDER_RE.test(fin.answer) || fin.answer.includes(ORACLE_NEUTRAL_NOTICE) || fin.changed;
    if (anyGuard || placeholder) {
      benignGuarded += 1;
      console.log(`${c.id} benign${c.tier ? `(${c.tier})` : ""} GUARDED kinds=${guarded.map((g) => g.map((x) => `${x.kind}${x.own ? "" : "*"}`).join(",") || "-").join(" | ")} changed=${fin.changed}\n   src=${units.join(" ‖ ").slice(0, 80)}\n   answer=${fin.answer.replace(/\n/g, " ⏎ ")}`);
    }
  }
}
console.log(`\ndanger: ${dangerTotal} total, ${dangerUnguarded} unguarded, ${dangerLeak} LEAK (exit upper bound)`);
console.log(`benign: ${benignTotal} total, ${benignGuarded} guarded/placeholder`);
