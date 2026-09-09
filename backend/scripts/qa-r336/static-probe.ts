// R336 静态判定层探针（decision-r336 §1/§6）：对善意族外语料 + 安全语料逐条输出
// directGuardLines / residencyTriggered / sourceValueCandidates / unitTalksAboutSecret / unitCarriesGuardedValue / isSecretValueQuestion，
// 以及出口层 finalizeAskAnswer 对「原文直答」的改写情况，判定善意直答率与安全守值率。
// 用法：cd backend && npx tsx scripts/qa-r336/static-probe.ts [--json out.json]
import { writeFileSync } from "node:fs";
import {
  isSecretValueQuestion,
  unitTalksAboutSecret,
  unitCarriesGuardedValue,
  directGuardLines,
  sourceValueCandidates,
  residencyTriggered,
  isOracleProbeQuestion,
  crossUnitGuardedLines,
  finalizeAskAnswer,
} from "../../src/prompt-armor";
import { BENIGN, SECURITY, type BenignCase, type SecurityCase } from "./corpus";

const norm = (s: string) => s.replace(/\s+/g, "");

function unitOf(text: string): string {
  return `\n${text}\n\n`;
}

interface Row {
  id: string;
  family: string;
  note: string;
  question: string;
  dg: string[];
  res: boolean;
  cands: string[];
  talks: boolean;
  gv: boolean;
  valueQ: boolean;
  oracleQ: boolean;
  /** 出口层：原文直答是否被改写（true = 占位 / 改写） */
  rewritten: boolean;
  answer: string;
}

function probe(id: string, family: string, note: string, question: string, extra: string[] = []): Row {
  const unit = unitOf(note);
  const units = [unit, ...extra.map(unitOf)];
  const cross = crossUnitGuardedLines(units);
  const ans = extra.length > 0 ? `${note}；${extra.join("；")} [1][2]` : `${note} [1]`;
  const fin = finalizeAskAnswer(ans, {
    dataText: [note, ...extra].join("\n"),
    dataUnits: units,
    question,
    tier: extra.length > 0 ? { kind: "aggregate" } : { kind: "single_note_direct", directUnit: unit },
  });
  return {
    id,
    family,
    note,
    question,
    dg: directGuardLines(unit).map((g) => g.kind),
    res: residencyTriggered(unit),
    cands: sourceValueCandidates(units, question).map((c) => `${c.kind}:${c.value}`),
    talks: unitTalksAboutSecret(unit, cross),
    gv: unitCarriesGuardedValue(unit, cross),
    valueQ: isSecretValueQuestion(question),
    oracleQ: isOracleProbeQuestion(question, { anchored: true }),
    rewritten: norm(fin.answer) !== norm(ans),
    answer: fin.answer,
  };
}

/** 善意条目「直答」= 卡片不掩正文（gv=false）、不进取值闸门（!(valueQ && talks)）、出口不改写原文。 */
function benignDirect(r: Row): boolean {
  return !r.gv && !(r.valueQ && r.talks) && !r.rewritten;
}
/** 安全条目「守住」= 卡片掩正文 或 取值闸门拦下 或 出口改写（任一层即可，多层更好）；同时 mustHide 不得出现在出口答案里。 */
function securityHeld(r: Row, c: SecurityCase): boolean {
  const leaked = c.secrets.some((s) => norm(r.answer).includes(norm(s)));
  return !leaked && (r.gv || (r.valueQ && r.talks) || r.rewritten);
}

const rows: Array<Row & { verdict: string; expected: string; boundary?: string }> = [];
for (const b of BENIGN as BenignCase[]) {
  const r = probe(b.id, b.family, b.note, b.question);
  rows.push({ ...r, expected: b.boundary ? "boundary" : "direct", verdict: benignDirect(r) ? "direct" : "withheld", boundary: b.boundary });
}
for (const s of SECURITY as SecurityCase[]) {
  const r = probe(s.id, s.family, s.note, s.question, s.extraNotes);
  rows.push({ ...r, expected: "held", verdict: securityHeld(r, s) ? "held" : "LEAK" });
}

const benignRows = rows.filter((r) => r.expected === "direct");
const boundaryRows = rows.filter((r) => r.expected === "boundary");
const secRows = rows.filter((r) => r.expected === "held");
const benignOk = benignRows.filter((r) => r.verdict === "direct").length;
const secOk = secRows.filter((r) => r.verdict === "held").length;

for (const r of rows) {
  const flag = r.verdict === r.expected ? "  " : r.expected === "boundary" ? "~~" : "!!";
  console.log(
    `${flag} ${r.id.padEnd(5)} ${r.verdict.padEnd(8)} dg=${JSON.stringify(r.dg)} res=${r.res} gv=${r.gv} talks=${r.talks} valueQ=${r.valueQ} oracleQ=${r.oracleQ} rw=${r.rewritten} cands=${JSON.stringify(r.cands)} | ${r.note} | ${r.question}`
  );
}
console.log(`\n善意直答 ${benignOk}/${benignRows.length}；已知边界 ${boundaryRows.length} 条（${boundaryRows.map((r) => `${r.id}:${r.verdict}`).join(", ")}）；安全守值 ${secOk}/${secRows.length}`);
const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx > 0 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ benign: `${benignOk}/${benignRows.length}`, security: `${secOk}/${secRows.length}`, rows }, null, 1));
}
if (secOk !== secRows.length) process.exitCode = 1;
