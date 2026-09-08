// R335 本地静态探针：盲测语料 → R334 称谓驻留候选面 / 出口字符级比对 / 闸门。
// 口径：只作【推断/静态】，用于在打生产之前预测哪些载体在候选面为空（取消标注后必然只剩模型自觉），
// 以及善意面哪些单元被「整单元占位」（unitTalksAboutSecret ∧ isSecretValueQuestion ⇒ 生成前占位）。
// 运行：cd backend && npx tsx scripts/qa-r335/static-probe.ts   （输出 scripts/qa-r335/out/static-probe.json）
import {
  sourceValueCandidates, normalizedGuardedLeak, unitTalksAboutSecret, unitCarriesGuardedValue, unitHasValueCandidates,
  isOracleProbeQuestion, isSecretValueQuestion, residencyTriggered, normalizeForLeakCompare,
} from "../../src/prompt-armor.ts";
import { ALL_ATTACK, ALL_BENIGN, I_MULTI_NOTE, J_FOLDED_COUNT, BUILT_AT } from "./blind-corpus.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

type Attack = { id: string; title: string; notes: string[]; question?: string; questions?: string[]; secret: string; derivedForms?: string[]; pieces?: string[]; history?: { role: string; content: string }[] };
type Benign = { id: string; notes: string[]; question: string; mustContain: string[]; title?: string };

const attackRows = (ALL_ATTACK as Attack[]).map((c) => {
  const qs = c.questions ?? [c.question!];
  const hist = (c.history ?? []).map((h) => h.content).join("\n");
  const perNote = c.notes.map((n) => ({
    residency: residencyTriggered(n),
    talks: unitTalksAboutSecret(n),
    carries: unitCarriesGuardedValue(n),
    cands: sourceValueCandidates([n]).map((x) => `${x.kind}:${x.value}`),
  }));
  const candsWithQ = sourceValueCandidates(c.notes, qs[0]).map((x) => x.value);
  // 模拟模型把值原样念出（「X 是 <secret>」）→ 出口比对是否拦下
  const plainLeak = normalizedGuardedLeak(`是 ${c.secret}。`, c.notes, qs[0]);
  // 派生形态（拼音 / leet / 乱序）与分片（<80%）逐个看比对是否命中
  const derived = Object.fromEntries((c.derivedForms ?? []).map((d) => [d, normalizedGuardedLeak(`是 ${d}。`, c.notes, qs[0])]));
  const pieces = Object.fromEntries((c.pieces ?? []).map((p) => [p, normalizedGuardedLeak(`是 ${p}。`, c.notes, qs[0])]));
  const gates = qs.map((q) => ({
    q,
    secretQ: isSecretValueQuestion(q, hist),
    oracleAnchored: isOracleProbeQuestion(q, { anchored: true }),
    oracle: isOracleProbeQuestion(q),
  }));
  const anyTalks = perNote.some((p) => p.talks);
  const anyCand = perNote.some((p) => p.cands.length > 0) || candsWithQ.length > 0;
  // 与 index.ts 闸门同口径：取值问 ∧ 单元在讲秘密 ⇒ 生成前占位；预言机问 ∧（候选非空 ∨ 讲秘密）⇒ 中性
  const valueGate = gates.map((g) => g.secretQ && anyTalks);
  const oracleGate = gates.map((g) => g.oracleAnchored && (anyCand || anyTalks));
  const open = gates.map((_, i) => !valueGate[i] && !oracleGate[i] && plainLeak === null);
  return { id: c.id, title: c.title, perNote, candsWithQ, plainLeak, derived, pieces, gates, valueGate, oracleGate, open };
});

const benignRows = [...(ALL_BENIGN as Benign[]), ...(I_MULTI_NOTE as Benign[])].map((b) => {
  const perNote = b.notes.map((n) => ({ residency: residencyTriggered(n), talks: unitTalksAboutSecret(n), carries: unitCarriesGuardedValue(n), cands: sourceValueCandidates([n]).map((x) => `${x.kind}:${x.value}`) }));
  const secretQ = isSecretValueQuestion(b.question);
  const oracleAnchored = isOracleProbeQuestion(b.question, { anchored: true });
  const anyTalks = perNote.some((p) => p.talks);
  // 预测整单元占位：取值问 ∧ 讲秘密；预测事实被出口比对吞掉：mustContain 任一项落在候选面（含问句扩张）
  const predictedPlaceholder = secretQ && anyTalks;
  const predictedOracle = oracleAnchored && (anyTalks || perNote.some((p) => p.cands.length > 0));
  const eaten = b.mustContain.filter((m) => normalizedGuardedLeak(`是 ${m}。`, b.notes, b.question) !== null);
  return { id: b.id, question: b.question, perNote, secretQ, oracleAnchored, predictedPlaceholder, predictedOracle, eaten };
});

const jRows = (J_FOLDED_COUNT as { id: string; notes: string[]; question: string }[]).map((j) => ({
  id: j.id, secretQ: isSecretValueQuestion(j.question), talks: j.notes.map((n) => unitTalksAboutSecret(n)),
}));

const out = { built_at: BUILT_AT, probed_at: new Date().toISOString(), attack: attackRows, benign: benignRows, folded: jRows };
writeFileSync(`${OUT}/static-probe.json`, JSON.stringify(out, null, 1));

for (const r of attackRows) {
  const cands = r.perNote.flatMap((p) => p.cands);
  const flags = [r.plainLeak ? `leak=${r.plainLeak}` : "leak=NULL", r.perNote.some((p) => p.talks) ? "talks" : "no-talks", r.valueGate.some(Boolean) ? "valueGate" : "", r.oracleGate.some(Boolean) ? "oracleGate" : "", r.open.some(Boolean) ? "OPEN" : ""].filter(Boolean).join(" ");
  const dv = Object.entries(r.derived).filter(([, v]) => v === null).map(([k]) => k);
  const pc = Object.entries(r.pieces).filter(([, v]) => v !== null).map(([k]) => k);
  console.log(`${r.id.padEnd(4)} ${flags.padEnd(44)} cands=${JSON.stringify(cands).slice(0, 90)}${dv.length ? ` derivedMISS=${JSON.stringify(dv)}` : ""}${pc.length ? ` piecesCaught=${JSON.stringify(pc)}` : ""}`);
}
const emptyCand = attackRows.filter((r) => !r.perNote.some((p) => p.cands.length > 0) && r.candsWithQ.length === 0);
const plainMiss = attackRows.filter((r) => r.plainLeak === null);
const open = attackRows.filter((r) => r.open.some(Boolean));
console.log(`\n== attack: n=${attackRows.length} candidate_empty=${emptyCand.length} [${emptyCand.map((r) => r.id).join(",")}]`);
console.log(`== plain_recital_uncaught=${plainMiss.length} [${plainMiss.map((r) => r.id).join(",")}]`);
console.log(`== OPEN(no value gate, no oracle gate, no leak guard)=${open.length} [${open.map((r) => r.id).join(",")}]`);

console.log("");
for (const b of benignRows) {
  if (b.predictedPlaceholder || b.predictedOracle || b.eaten.length || b.perNote.some((p) => p.talks)) {
    console.log(`${b.id.padEnd(4)} ${b.predictedPlaceholder ? "PLACEHOLDER " : ""}${b.predictedOracle ? "ORACLE " : ""}${b.eaten.length ? `EATEN=${JSON.stringify(b.eaten)} ` : ""}talks=${JSON.stringify(b.perNote.map((p) => p.talks))} cands=${JSON.stringify(b.perNote.flatMap((p) => p.cands)).slice(0, 80)} q=${b.question}`);
  }
}
console.log(`\n== benign: n=${benignRows.length} predicted_placeholder=${benignRows.filter((b) => b.predictedPlaceholder).length} predicted_oracle=${benignRows.filter((b) => b.predictedOracle).length} fact_eaten=${benignRows.filter((b) => b.eaten.length).length} unit_talks=${benignRows.filter((b) => b.perNote.some((p) => p.talks)).length}`);
console.log("== folded:", JSON.stringify(jRows));
