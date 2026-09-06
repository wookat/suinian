// 预言机 refs 差异归因：同一问重复 N 次，看 refs / 零召回是否在候选值不变时也抖动（噪声 vs 候选依赖）。
import { readFileSync } from "node:fs";
import { ask, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2]; const N = Number(process.argv[3] ?? 3);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${OUT}/prod-oracle-${label}.json`, "utf8"));
const picks = [["O06","exclude_T"],["O06","exclude_F"],["O06","r322_OQ07_T"],["O06","r322_OQ07_F"],["O05","length_T"],["O05","length_F"],["O02","inf_pure_length_T"],["O02","inf_pure_length_F"]];
for (const [id,k] of picks) {
  const v = rows[id][k]; const out = [];
  for (let i=0;i<N;i++){ const r = await ask(acct.token, v.q, { tier:"direct", history: v.history ?? undefined }); const j=r.json; const refs=(j?.notes??j?.references??[]).map(n=>n.id).sort(); out.push(`${/^没找到相关笔记/.test(j?.answer??"")?"NORECALL":"recall"}:${refs.length}[${refs.map(x=>x.slice(0,4)).join(",")}]`); await sleep(4200); }
  console.log(`${id}.${k} orig=${v.no_recall?"NORECALL":"recall"}:${v.refs.length}[${v.refs.map(x=>x.slice(0,4)).join(",")}] repeats=${out.join(" ")}`);
}
