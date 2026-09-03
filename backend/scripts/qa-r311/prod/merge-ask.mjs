// 合并各分片的生产 Ask 结果（prod-ask-<kind>-<suffix>.json），按语料类别 × 模式汇总；
// 冲突 ID（首轮 seed 被跳过的 N01..N05 → 重 seed 后为 N01b..N05b）以 b 后缀版本为准，旧无效行丢弃。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const OUT = new URL("../out", import.meta.url).pathname;
const kind = process.argv[2] ?? "danger";
const items = JSON.parse(readFileSync(`${OUT}/${kind === "danger" ? "carriers" : "benign"}.json`, "utf8"));
const catOf = new Map(items.map((c) => [c.id, c.cat ?? "reg"]));
const dupBase = new Set(items.filter((c) => c.cat === "r311" && c.id.endsWith("b") && catOf.has(c.id.slice(0, -1))).map((c) => c.id.slice(0, -1)));

const rows = {};
for (const f of readdirSync(OUT).filter((f) => f.startsWith(`prod-ask-${kind}`) && f.endsWith(".json") && !f.includes("final"))) {
  const d = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  for (const [id, modes] of Object.entries(d)) {
    if (!catOf.has(id)) continue;
    rows[id] ??= {};
    for (const [m, v] of Object.entries(modes)) {
      if (m === "multiturn_merged_leaked") { rows[id][m] = v; continue; }
      if (v?.status === 200 && !rows[id][m]) rows[id][m] = { ...v, _src: f };
    }
  }
}
// 旧分片里以 reg 的 N01..N05 note 记录的 r311 问句：那 5 条 r311 笔记当时未入库，行无效——
// 这里 id 为 N01..N05 的行来源于 reg 语料（carriers.json 里同 id 首条即 reg），照常按 reg 统计。
const modes = ["normal", "verbatim", "qinject", "multiturn", "multiturn2"];
const summary = {};
for (const m of modes) {
  for (const [id, r] of Object.entries(rows)) {
    const v = r[m];
    if (!v) continue;
    const cat = catOf.get(id);
    const s = (summary[`${cat}/${m}`] ??= { n: 0, isolated: 0, whole_isolated: 0, marked: 0, placeholder: 0, redirect: 0, cited: 0, cited_unfolded: 0, leaked: 0, echo_raw: 0, leaked_ids: [], echo_ids: [] });
    s.n++;
    s.isolated += v.isolated ? 1 : 0;
    s.whole_isolated += v.whole_isolated ? 1 : 0;
    s.marked += v.marked ? 1 : 0;
    s.placeholder += /〔/.test(v.answer) ? 1 : 0;
    s.redirect += v.verbatim_redirect ? 1 : 0;
    s.cited += v.cited ? 1 : 0;
    s.cited_unfolded += v.cited && v.cited_fold === false ? 1 : 0;
    if (v.leaked?.length) { s.leaked++; s.leaked_ids.push(id); }
    if (v.echo_raw?.length) { s.echo_raw++; s.echo_ids.push(id); }
  }
}
const merged = {};
for (const [id, r] of Object.entries(rows)) {
  if (!r.multiturn_merged_leaked) continue;
  const cat = catOf.get(id);
  const s = (merged[cat] ??= { n: 0, leaked: 0, ids: [] });
  s.n++;
  if (r.multiturn_merged_leaked.length) { s.leaked++; s.ids.push(id); }
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
for (const [k, s] of Object.entries(summary)) {
  console.log(`[${kind}/${k}] n=${s.n} isolated=${s.isolated} whole=${s.whole_isolated}(${pct(s.whole_isolated, s.n)}) placeholder=${s.placeholder} redirect=${s.redirect} cited=${s.cited} citedUnfolded=${s.cited_unfolded} leaked=${s.leaked}(${pct(s.leaked, s.n)}) echo_raw=${s.echo_raw}(${pct(s.echo_raw, s.n)})`);
  if (s.leaked_ids.length) console.log(`   leaked: ${s.leaked_ids.join(",")}`);
  if (s.echo_ids.length) console.log(`   echo_raw: ${s.echo_ids.join(",")}`);
}
for (const [cat, s] of Object.entries(merged)) console.log(`[${kind}/${cat}/跨轮累积] n=${s.n} leaked=${s.leaked}(${pct(s.leaked, s.n)}) ${s.ids.join(",")}`);
writeFileSync(`${OUT}/prod-ask-${kind}-final.json`, JSON.stringify({ summary, multiturn_merged: merged, rows }, null, 1));
console.log(`dupBase=${[...dupBase].join(",")}`);
