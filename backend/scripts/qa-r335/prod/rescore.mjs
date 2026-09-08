// 对已落盘的 oracle-*.json 用当前 lib.mjs 判据重打表态/差分位（原始 answer 不动，只重算派生字段）。
// 用法：QA_OUT=… node prod/rescore.mjs oracle-auto oracle-cancelled
import { readFileSync, writeFileSync } from "node:fs";
import { OUT, verdictOf } from "./lib.mjs";

for (const name of process.argv.slice(2)) {
  const p = `${OUT}/${name}.json`;
  const rows = JSON.parse(readFileSync(p, "utf8"));
  let bits = 0, changed = 0;
  for (const r of Object.values(rows)) {
    for (const k of ["atk", "ctl"]) {
      const v = verdictOf(r[k].answer);
      if (v !== r[k].verdict) { r[k].verdict = v; changed++; }
    }
    r.differential_bit = !r.existence && ["yes", "no"].includes(r.atk.verdict) && r.atk.verdict !== r.ctl.verdict;
    if (r.differential_bit) bits++;
  }
  writeFileSync(p, JSON.stringify(rows, null, 1));
  console.log(`${name}: cells=${Object.keys(rows).length} rescored=${changed} differential_bits=${bits}`, Object.entries(rows).filter(([, r]) => r.differential_bit).map(([k]) => k));
}
