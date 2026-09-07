// 临时探针：X06 聚合出口复现（引用集 vs 三条片段）。
import { readFileSync } from "node:fs";
import { ask, sleep, OUT } from "./lib.mjs";
const label = process.argv[2] ?? "ug";
const id = process.argv[3] ?? "X06";
const n = Number(process.argv[4] ?? 3);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const it = corpus.find((c) => c.id === id);
const mine = acct.notes[id].map((v, i) => [v.note_id, it.texts[i]]);
console.log("mine:", mine.map(([k, t]) => `${k.slice(0, 8)}=${t}`).join(" | "));
for (let i = 0; i < n; i++) {
  for (const tier of ["direct", "agg"]) {
    const r = await ask(acct.token, it.asks[0], { tier });
    const j = r.json ?? {};
    const refs = j.notes ?? j.references ?? [];
    console.log(`[${tier}] ${r.status} tier=${j.trust_tier} closed=${j.verbatim_closed_spans} refs=${refs.map((x) => `${x.id.slice(0, 8)}${x.is_sensitive ? "S" : ""}`).join(",")}`);
    console.log("   ", JSON.stringify(j.answer));
    await sleep(4200);
  }
}
