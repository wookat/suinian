/**
 * R325 本地探针：用 R325 盲测语料直接调用生产同一份判定函数（读实现后才写，语料不改）。
 * 对每条载体给出 R324 三道判定在本地的实际取值：
 *   talking  = unitTalksAboutSecret（数据层「在讲秘密」标注）
 *   guards   = directGuardLines（受守行 = 会被替换出模型上下文的行）
 *   gate     = oracle / value / -（isOracleProbeQuestion / isSecretValueQuestion 命中 ⇒ 确定性占位，不进生成）
 *   ctx_leak = modelContextNoteText 送模型的文本里 needles 是否仍在（漏标注 ⇒ 漏替换的传导）
 *   exit     = 「模型如实照做」的最坏答案过 finalizeAskAnswer 后 needles 是否存活（出口层兜底）
 * 目的：把「哪些盲测载体只剩出口层兜底 / 完全无防护」在本地先定位，生产实测再确证。
 * 用法：npx tsx scripts/qa-r325/probe-gate.ts [V|L|B|Q|I|all]
 */
import { V, L, B, Q } from "./blind-carriers";
import { INFORMED } from "./informed-carriers";
import { modelContextNoteText } from "../../src/ask-context";
import {
  directGuardLines,
  crossUnitGuardedLines,
  finalizeAskAnswer,
  normalizeForLeakCompare,
  isSecretValueQuestion,
  isOracleProbeQuestion,
  unitTalksAboutSecret,
  DIRECT_GUARD_PLACEHOLDER,
  ORACLE_NEUTRAL_NOTICE,
} from "../../src/prompt-armor";

const askGuardNoteUnit = (content: string): string => `\n${content}\n\n`;
const sel = process.argv[2] ?? "all";
const BUDGET = 500;

type Row = { id: string; family: string; texts: string[]; asks: string[]; needles: string[]; answer: string; cat: "danger" | "benign"; seam?: string };
const qRows: Row[] = Q.flatMap((q) => [
  { id: `${q.id}T`, family: q.family, texts: [q.text], asks: [q.askT.replaceAll("{S}", q.subject)], needles: [q.secret], answer: q.secret, cat: "danger", seam: q.channel },
  { id: `${q.id}F`, family: q.family, texts: [q.text], asks: [q.askF.replaceAll("{S}", q.subject)], needles: [q.secret], answer: q.secret, cat: "danger", seam: q.channel },
]);
const items: Row[] = sel === "V" ? V : sel === "L" ? L : sel === "B" ? B : sel === "Q" ? qRows : sel === "I" ? INFORMED : [...V, ...L, ...B, ...qRows];

const stat = { danger: 0, gated: 0, talking: 0, guarded: 0, ctxLeak: 0, exitLeak: 0, exposed: 0, benign: 0, benignGated: 0, benignGuarded: 0 };
for (const c of items) {
  const units = c.texts.map(askGuardNoteUnit);
  const cross = crossUnitGuardedLines(units);
  const guards = units.map((u) => directGuardLines(u));
  const anyGuard = guards.some((g) => g.length > 0) || cross.size > 0;
  const talking = units.some((u) => unitTalksAboutSecret(u, cross));
  const question = c.asks[c.asks.length - 1];
  const hist = c.asks.slice(0, -1).join("\n");
  const gate = talking && isOracleProbeQuestion(question) ? "oracle" : talking && isSecretValueQuestion(question, hist) ? "value" : null;
  const qShape = `${isOracleProbeQuestion(question) ? "O" : "-"}${isSecretValueQuestion(question, hist) ? "V" : "-"}`;
  const ctx = c.texts.map((t, i) => modelContextNoteText({ title: null, content: t, unit: units[i], crossGuarded: cross, budget: BUDGET }).text);
  const ctxNorm = normalizeForLeakCompare(ctx.join("\n"));
  const inCtx = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && ctxNorm.includes(normalizeForLeakCompare(n)));
  const fin = gate
    ? { answer: gate === "oracle" ? ORACLE_NEUTRAL_NOTICE : DIRECT_GUARD_PLACEHOLDER.credential, changed: true }
    : finalizeAskAnswer(c.answer, {
        dataText: c.texts.join("\n"),
        dataUnits: c.texts,
        question,
        verbatimExempt: c.asks.join("\n"),
        tier: c.texts.length === 1 ? { kind: "single_note_direct", directUnit: c.texts[0] } : { kind: "aggregate" },
      });
  const finNorm = normalizeForLeakCompare(fin.answer);
  const exitSurvive = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && finNorm.includes(normalizeForLeakCompare(n)));
  const g = guards.map((x) => x.map((y) => `${y.kind}${y.own ? "" : "*"}`).join(",") || "-").join("|");
  if (c.cat === "danger") {
    stat.danger++;
    if (gate) stat.gated++;
    if (talking) stat.talking++;
    if (anyGuard) stat.guarded++;
    if (inCtx.length) stat.ctxLeak++;
    if (exitSurvive.length) stat.exitLeak++;
    if (!gate && inCtx.length) stat.exposed++;
    console.log(
      `${c.id.padEnd(5)} gate=${(gate ?? "-").padEnd(6)} q=${qShape} talking=${talking ? "Y" : "n"} guards=${g.padEnd(12)} ctx_leak=${inCtx.length ? "Y" : "-"} exit_leak=${exitSurvive.length ? "Y" : "-"}  ${c.seam ?? c.family}` +
        (!gate && inCtx.length ? `\n      ↳ 仅剩出口层：ctx=${JSON.stringify(inCtx)} exit=${JSON.stringify(exitSurvive)}` : "")
    );
  } else {
    stat.benign++;
    if (gate) stat.benignGated++;
    if (anyGuard || fin.changed) stat.benignGuarded++;
    if (gate || anyGuard || fin.changed) console.log(`${c.id.padEnd(5)} benign gate=${gate ?? "-"} q=${qShape} talking=${talking ? "Y" : "n"} guards=${g} changed=${fin.changed} | ${c.texts[0].slice(0, 40)} ⇐ ${question}`);
  }
}
console.log(
  `\n== ${sel}: danger=${stat.danger} gated=${stat.gated} talking=${stat.talking} guarded=${stat.guarded} ctx_leak=${stat.ctxLeak} exit_leak(worst-answer)=${stat.exitLeak} exposed(no gate & in ctx)=${stat.exposed} | benign=${stat.benign} gated=${stat.benignGated} guarded_or_changed=${stat.benignGuarded}`
);
