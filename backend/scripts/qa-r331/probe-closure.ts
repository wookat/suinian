/**
 * R331 本机探针（只读调用产品函数，不改产品代码）：把 R331 盲测语料过 R330 的出口层与闸门，
 * 先于生产实测给出「哪些形态在**出口层根本没有比对面**」的清单（生产实测再确认模型是否真的照做）。
 *
 *  - cands：sourceValueCandidates(units, lastAsk) 的候选值（空 ⇒ 短值兜底无比对面）；
 *  - gate：R330 test 同款闸门推定（oracle 中性短路 / 取值问占位 / 无闸门 ⇒ 进生成）；
 *  - direct / agg / mcp：以载体 `answer`（模型如实照做的最坏形态）过 finalizeAskAnswer（直答 / 聚合 tier）与 closeMcpAskAnswer，
 *    量 needles 归一化命中（survive）与 semNeedles 正则命中（semantic）。
 *  - 善意：`<原文> [1]` 过直答 tier，统计被改写 / 占位的条数与候选面非空的条数。
 * 运行：cd backend && npx tsx scripts/qa-r331/probe-closure.ts
 */
import { DANGER, B, type R331Carrier } from "./blind-carriers";
import {
  finalizeAskAnswer,
  normalizeForLeakCompare,
  sourceValueCandidates,
  crossUnitGuardedLines,
  directGuardLines,
  isSecretValueQuestion,
  isOracleProbeQuestion,
  isYesNoQuestion,
  unitTalksAboutSecret,
  DIRECT_GUARD_PLACEHOLDER,
  ORACLE_NEUTRAL_NOTICE,
} from "../../src/prompt-armor";
import { askGuardNoteUnit } from "../../src/index";
import { closeMcpAskAnswer } from "../../src/mcp";

const norm = normalizeForLeakCompare;
const leaked = (text: string, needles: string[]) =>
  needles.filter((n) => (norm(n).length >= 3 ? norm(text).includes(norm(n)) : text.replace(/\[\d+\]/g, "").includes(n)));
const semantic = (text: string, res: string[] | undefined) => (res ?? []).filter((r) => new RegExp(r, "iu").test(text));
const unitsOf = (c: R331Carrier) => c.texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
const lastAsk = (c: R331Carrier) => c.asks[c.asks.length - 1];

function gateOf(c: R331Carrier, q: string): "oracle" | "value" | null {
  const units = unitsOf(c);
  const cross = crossUnitGuardedLines(units);
  const guardedUnit = units.some((u) => directGuardLines(u).length > 0 || u.split("\n").some((l) => cross.has(l.trim())));
  if (guardedUnit && (isYesNoQuestion(q) || isOracleProbeQuestion(q, { anchored: true }) || isOracleProbeQuestion(q))) return "oracle";
  if (isSecretValueQuestion(q) && units.some((u) => unitTalksAboutSecret(u, cross))) return "value";
  return null;
}

const totals = { n: 0, empty: 0, gateOracle: 0, gateValue: 0, direct: 0, agg: 0, mcp: 0, semDirect: 0, semAgg: 0, semMcp: 0 };
const byFam: Record<string, { n: number; open: number }> = {};
for (const c of DANGER) {
  const units = unitsOf(c);
  const q = lastAsk(c);
  const cands = sourceValueCandidates(units, q).map((x) => x.value);
  const gate = gateOf(c, q);
  const base = { dataText: c.texts.join("\n"), dataUnits: units, question: q };
  let direct = c.answer;
  let agg = c.answer;
  let mcp = c.answer;
  if (gate === "oracle") direct = agg = mcp = ORACLE_NEUTRAL_NOTICE;
  else if (gate === "value") direct = agg = mcp = DIRECT_GUARD_PLACEHOLDER.credential;
  else {
    direct = finalizeAskAnswer(c.answer, { ...base, tier: { kind: "single_note_direct", directUnit: units[units.length - 1] } }).answer;
    agg = finalizeAskAnswer(c.answer, base).answer;
    mcp = closeMcpAskAnswer(c.answer, units, q).answer;
  }
  const ld = leaked(direct, c.needles), lg = leaked(agg, c.needles), lm = leaked(mcp, c.needles);
  const sd = semantic(direct, c.semNeedles), sg = semantic(agg, c.semNeedles), sm = semantic(mcp, c.semNeedles);
  totals.n++;
  if (cands.length === 0) totals.empty++;
  if (gate === "oracle") totals.gateOracle++;
  if (gate === "value") totals.gateValue++;
  if (ld.length) totals.direct++;
  if (lg.length) totals.agg++;
  if (lm.length) totals.mcp++;
  if (sd.length) totals.semDirect++;
  if (sg.length) totals.semAgg++;
  if (sm.length) totals.semMcp++;
  const fam = c.id[0];
  byFam[fam] ??= { n: 0, open: 0 };
  byFam[fam].n++;
  const open = ld.length || lg.length || lm.length || sd.length || sg.length || sm.length;
  if (open) byFam[fam].open++;
  console.log(
    `${c.id.padEnd(4)} ${c.family.padEnd(34)} gate=${String(gate).padEnd(6)} cands=${JSON.stringify(cands).slice(0, 60)} ` +
      `direct=${ld.length ? "LEAK" : sd.length ? "SEM" : "ok"} agg=${lg.length ? "LEAK" : sg.length ? "SEM" : "ok"} mcp=${lm.length ? "LEAK" : sm.length ? "SEM" : "ok"}` +
      (open ? ` :: ${JSON.stringify(direct).slice(0, 80)}` : ""),
  );
}
console.log(
  `== R331 danger ${totals.n}: empty_candidates=${totals.empty} gate_oracle=${totals.gateOracle} gate_value=${totals.gateValue} ` +
    `direct_leak=${totals.direct} agg_leak=${totals.agg} mcp_leak=${totals.mcp} semantic_direct=${totals.semDirect} semantic_agg=${totals.semAgg} semantic_mcp=${totals.semMcp}`,
);
console.log("== by family (open = 任一出口 survive 或 semantic): " + Object.entries(byFam).map(([f, v]) => `${f}=${v.open}/${v.n}`).join(" "));

const changed: string[] = [];
const withCands: string[] = [];
const gated: string[] = [];
for (const c of B) {
  const units = unitsOf(c);
  const q = c.asks[0];
  const ans = `${c.texts[0]} [1]`;
  const cands = sourceValueCandidates(units, q).map((x) => x.value);
  if (cands.length > 0) withCands.push(`${c.id}${JSON.stringify(cands)}`);
  const gate = gateOf(c, q);
  if (gate) gated.push(`${c.id}:${gate}`);
  const d = finalizeAskAnswer(ans, { dataText: c.texts[0], dataUnits: units, question: q, tier: { kind: "single_note_direct", directUnit: units[0] } }).answer;
  if (d !== ans) changed.push(c.id);
}
console.log(`== R331 benign ${B.length}: direct_changed=${changed.length} [${changed.join(",")}] gated=[${gated.join(",")}] candidates=[${withCands.join(" ")}]`);
