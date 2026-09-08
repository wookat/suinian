// R334 本地静态探针（族外语料 → 称谓驻留候选面 / 归一化比对 / 闸门矩阵；同 qa-r333/candidates.ts 口径）
// 目的：在打生产之前先知道「这条载体在候选面里有没有形态」——候选面为空的载体，出口只剩数据层标注 + 模型自觉，
// 取消标注后必然裸出（R331 根因同款）。结果只作【推断/静态】口径，生产实测另算。
// 运行：cd backend && npx tsx scripts/qa-r333/candidates.ts
import { sourceValueCandidates, normalizedGuardedLeak, unitHasValueCandidates, isOracleProbeQuestion, isSecretValueQuestion, unitTalksAboutSecret } from "../../src/prompt-armor.ts";
import { CARRIERS, BENIGN, GENERIC_ASKS, ORACLE_ASKS } from "./blind-corpus.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

type Row = {
  id: string; family: string; cands: string[]; secretQ: boolean;
  covered: Record<string, string | null>; uncovered: string[];
};
const rows: Row[] = [];
for (const c of CARRIERS) {
  const q = GENERIC_ASKS.direct.replace("{topic}", c.topic);
  const cands = sourceValueCandidates([c.note], q).map((x) => x.value);
  const covered: Record<string, string | null> = {};
  for (const s of c.secrets) {
    // 模拟模型把值原样说出来（含最常见的「是 X」句式），看出口归一化比对能否拦下
    covered[s] = normalizedGuardedLeak(`${c.topic}是 ${s}。`, [c.note], q);
  }
  const uncovered = c.secrets.filter((s) => covered[s] === null);
  rows.push({ id: c.id, family: c.family, cands, secretQ: isSecretValueQuestion(q), covered, uncovered });
  console.log(`${c.id} ${c.family.padEnd(22)} cands=${JSON.stringify(cands)} secretQ=${isSecretValueQuestion(q)} uncovered=${JSON.stringify(uncovered)}`);
}
// 闸门矩阵：每条载体 × 全部问法，问法既不是取值问（isSecretValueQuestion ∧ unitTalksAboutSecret ⇒ 生成前占位）
// 也不是预言机问（isOracleProbeQuestion ⇒ 中性话术）时，答案要真进生成，只剩 normalizedGuardedLeak 兜底；
// 兜底又没候选 ⇒ 静态预测「裸出」（取消标注后）。
const gateRows: { id: string; ask: string; valueGate: boolean; oracleGate: boolean; leakGuard: boolean }[] = [];
for (const c of CARRIERS) {
  const talks = unitTalksAboutSecret(c.note);
  const asks = [...Object.values(GENERIC_ASKS).map((t) => t.replace("{topic}", c.topic)), ...(c.asks ?? [])];
  for (const ask of asks) {
    const valueGate = talks && isSecretValueQuestion(ask);
    // 与 index.ts 预言机闸门同口径（R334 §14.1-3）：候选面非空 或 单元驻留称谓（unitTalksAboutSecret）都算受守材料
    const oracleGate = isOracleProbeQuestion(ask, { anchored: true }) && (unitHasValueCandidates(c.note) || talks);
    const leakGuard = c.secrets.every((s) => normalizedGuardedLeak(`${c.topic}是 ${s}。`, [c.note], ask) !== null);
    gateRows.push({ id: c.id, ask, valueGate, oracleGate, leakGuard });
  }
}
const open = gateRows.filter((g) => !g.valueGate && !g.oracleGate && !g.leakGuard);
console.log(`\n== gate matrix: asks=${gateRows.length} value_gate=${gateRows.filter((g) => g.valueGate).length} oracle_gate=${gateRows.filter((g) => g.oracleGate).length} leak_guard_full=${gateRows.filter((g) => g.leakGuard).length} OPEN(no gate, no guard)=${open.length}`);
for (const g of open) console.log(`   OPEN ${g.id} ${g.ask}`);
const openIds = [...new Set(open.map((g) => g.id))];
console.log(`== carriers with ≥1 OPEN ask: ${openIds.length} [${openIds.join(",")}]`);

const empty = rows.filter((r) => r.cands.length === 0);
const anyUncovered = rows.filter((r) => r.uncovered.length > 0);
const primaryUncovered = rows.filter((r) => r.covered[CARRIERS.find((c) => c.id === r.id)!.secrets[0]] === null);
console.log(`\n== carriers=${rows.length} candidate_surface_empty=${empty.length} [${empty.map((r) => r.id).join(",")}]`);
console.log(`== primary_secret_uncovered=${primaryUncovered.length} [${primaryUncovered.map((r) => r.id).join(",")}]`);
console.log(`== any_secret_form_uncovered=${anyUncovered.length} [${anyUncovered.map((r) => r.id).join(",")}]`);

// oracle 句式：R333 的 12 条问法有多少被 isOracleProbeQuestion（出口口径 / 带锚口径）认出
const oracleRows = ORACLE_ASKS.map((t) => {
  const q = t.replace("{topic}", "门锁密码");
  return { q, probe: isOracleProbeQuestion(q), anchored: isOracleProbeQuestion(q, { anchored: true }) };
});
for (const o of oracleRows) console.log(`oracle ${o.probe ? "PROBE" : "-----"} ${o.anchored ? "ANCH" : "----"} ${o.q}`);
console.log(`== oracle_asks=${oracleRows.length} recognized=${oracleRows.filter((o) => o.probe).length} anchored=${oracleRows.filter((o) => o.anchored).length}`);

// 善意语料：单元自身有候选 ⇒ 是非 / 属性问会被中和、取值问可能占位（误伤预测）
const benignRows = BENIGN.map((b) => ({ id: b.id, kind: b.kind, cands: sourceValueCandidates([b.note]).map((x) => x.value), has: unitHasValueCandidates(b.note), secretQ: isSecretValueQuestion(b.ask) }));
for (const b of benignRows) if (b.has || b.secretQ) console.log(`benign ${b.id} ${b.kind} cands=${JSON.stringify(b.cands)} secretQ=${b.secretQ}`);
console.log(`== benign=${benignRows.length} with_candidates=${benignRows.filter((b) => b.has).length} secret_value_question=${benignRows.filter((b) => b.secretQ).length}`);

writeFileSync(`${OUT}/candidates.json`, JSON.stringify({ carriers: rows, oracle: oracleRows, benign: benignRows }, null, 1));
