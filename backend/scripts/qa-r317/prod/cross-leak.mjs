// R317：跨载体泄漏——某问句的答案里出现了**别的**危险载体的 needle（检索串扰 / 「相近记录」列表带出）。
// 逐载体 needle 口径只看自己的 needle，会漏掉这类；这里补一遍。用法：node prod/cross-leak.mjs <label>
import { readFileSync } from "node:fs";
const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2] ?? "blind";
const corpusName = label === "inf" ? "informed" : label;
const corpus = JSON.parse(readFileSync(`${OUT}/${corpusName}.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${OUT}/prod-ask-${label}.json`, "utf8"));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const danger = corpus.filter((c) => c.cat === "danger");
let n = 0;
const seen = new Set();
for (const [id, R] of Object.entries(rows)) {
  for (const [k, v] of Object.entries(R)) {
    if (!v || typeof v !== "object" || v.status !== 200) continue;
    const a = norm(v.answer), q = norm(v.q ?? "");
    for (const o of danger) {
      if (o.id === id) continue;
      const hit = o.needles.filter((nd) => norm(nd).length >= 4 && a.includes(norm(nd)) && !q.includes(norm(nd)));
      if (hit.length) { n++; seen.add(`${id}->${o.id}`); console.log(`${id}/${k} carries ${o.id}[${hit.join("|")}] tier=${v.trust_tier}`); }
    }
  }
}
console.log(`== ${label}: cross_rows=${n} pairs=${seen.size}`);
