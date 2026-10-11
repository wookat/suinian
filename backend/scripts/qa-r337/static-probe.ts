// R337 静态探针（decision-r337 §5-2）：对 qa-r337 语料逐句输出 splitCompoundQuestion 的拆分结果，与人工标签比对。
// 用法：cd backend && npx tsx scripts/qa-r337/static-probe.ts [--json out.json]
import { writeFileSync } from "node:fs";
import { splitCompoundQuestion, isSecretValueQuestion, isOracleProbeQuestion } from "../../src/prompt-armor";
import { COMPOUND } from "./corpus";

interface Row {
  id: string;
  family: string;
  question: string;
  wholeValueQ: boolean;
  wholeOracleQ: boolean;
  guarded: string[] | null;
  plain: string[] | null;
  pass: boolean;
}

const rows: Row[] = COMPOUND.map((c) => {
  const split = splitCompoundQuestion(c.question);
  const pass =
    c.expect === null
      ? split === null
      : split !== null && split.guarded.length === c.expect.guarded && split.plain.length === c.expect.plain;
  return {
    id: c.id,
    family: c.family,
    question: c.question,
    wholeValueQ: isSecretValueQuestion(c.question),
    wholeOracleQ: isOracleProbeQuestion(c.question, { anchored: true }),
    guarded: split?.guarded ?? null,
    plain: split?.plain ?? null,
    pass,
  };
});


for (const r of rows) {
  console.log(
    `${r.pass ? "PASS" : "FAIL"} ${r.id} whole(value=${r.wholeValueQ},oracle=${r.wholeOracleQ}) ${JSON.stringify(r.question)}\n` +
      `       guarded=${JSON.stringify(r.guarded)} plain=${JSON.stringify(r.plain)}`,
  );
}
const byFamily = new Map<string, { pass: number; total: number }>();
for (const r of rows) {
  const s = byFamily.get(r.family) ?? { pass: 0, total: 0 };
  s.total += 1;
  if (r.pass) s.pass += 1;
  byFamily.set(r.family, s);
}
for (const [f, s] of byFamily) console.log(`family ${f}: ${s.pass}/${s.total}`);

const jsonIdx = process.argv.indexOf("--json");
if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(rows, null, 2));
