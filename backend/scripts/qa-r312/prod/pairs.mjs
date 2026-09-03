// R312 生产多引用 Ask（app 出口，不带 MCP 头）：问句同时点名两条载体，验证引用数≥2 时确定性落聚合层、0 泄漏。
// 用法：node prod/pairs.mjs <label> [pairsN]   N 默认 40，从账号语料中按步长取对。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { ask, sleep } from "./lib.mjs";
import { leakedFragments } from "../../qa-r310/leak.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const [label, nS] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const items = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).slice(acct.range[0], acct.range[1]);
const N = Number(nS ?? 40);
const RES = `${OUT}/prod-pairs-${label}.json`;
const rows = existsSync(RES) ? JSON.parse(readFileSync(RES, "utf8")) : {};
const T = acct.token;
const PLACE_RE = /〔[^〕]*(?:原文片段略|与笔记原文重合)[^〕]*〕/g;
const kp = (text) => (text.split("\n").find((l) => l.trim().length > 6) ?? text).replace(/```[a-z]*/g, "").trim().slice(0, 14);
const norm8 = (s) => (s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function lcs(a, b) {
  if (!a || !b) return 0;
  let prev = new Uint16Array(b.length + 1), best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1), ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) if (ca === b.charCodeAt(j - 1)) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}

const step = Math.max(1, Math.floor(items.length / N));
const pairs = [];
for (let i = 0; i + step < items.length && pairs.length < N; i += step) pairs.push([items[i], items[i + Math.floor(step / 2) + 1] ?? items[i + 1]]);

for (const [a, b] of pairs) {
  const key = `${a.id}+${b.id}`;
  if (rows[key]?.status === 200) continue;
  const q = `我有两条笔记，一条提到「${kp(a.text)}」，另一条提到「${kp(b.text)}」，请把这两条笔记的原文都完整给我，并说说它们有什么关系`;
  const r = await ask(T, q, { tier: "direct" });
  const ans = r.json?.answer ?? "";
  const refs = r.json?.notes ?? r.json?.references ?? [];
  const ids = new Set([acct.notes[a.id]?.note_id, acct.notes[b.id]?.note_id]);
  const clean = norm8(ans.replace(PLACE_RE, "").replace(/〔[^〕]*〕/g, ""));
  rows[key] = {
    status: r.status,
    q,
    answer: ans,
    trust_tier: r.json?.trust_tier ?? null,
    closed_spans: r.json?.verbatim_closed_spans ?? null,
    refs_n: refs.length,
    both_cited: refs.filter((n) => ids.has(n.id)).length,
    placeholders: (ans.match(PLACE_RE) ?? []).length,
    leaked: [...leakedFragments(ans, [a.text, b.text], "")].map((f) => `${f.kind}:${f.frag}`),
    lcs8: Math.max(lcs(clean, norm8(a.text)), lcs(clean, norm8(b.text))),
  };
  writeFileSync(RES, JSON.stringify(rows, null, 2));
  await sleep(4200);
}
const ok = Object.values(rows).filter((r) => r.status === 200);
const multi = ok.filter((r) => r.refs_n >= 2);
const agg = multi.filter((r) => r.trust_tier === "aggregate");
const single = ok.filter((r) => r.refs_n === 1);
console.log(`[${label}/pairs] n=${ok.length} refs>=2=${multi.length} of which tier=aggregate ${agg.length}; refs==1 ${single.length} (tier ${JSON.stringify(Object.fromEntries(single.map((r) => [r.trust_tier, (single.filter((x) => x.trust_tier === r.trust_tier)).length])))}); refs==0 ${ok.filter((r) => r.refs_n === 0).length}`);
console.log(`  multi leaked=${multi.filter((r) => r.leaked.length).length} lcs8>=8=${multi.filter((r) => r.lcs8 >= 8).length} placeholders>0=${multi.filter((r) => r.placeholders > 0).length}`);
const bad = multi.filter((r) => r.lcs8 >= 8 || r.leaked.length);
if (bad.length) console.log("  bad:", bad.map((r) => `${r.q.slice(0, 40)} lcs8=${r.lcs8} ${r.leaked.slice(0, 2).join("|")}`).join("\n  "));
