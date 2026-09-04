// R314：汇总 prod/ask.mjs 结果（out/prod-ask-<label>.json）——按信任域分层统计
//   聚合层（aggregate / 多轮 / SSE 累积）：needle 存活、LCS 泄漏、危险片段（token/line）逐条列出；
//   直答层（single_note_direct）：凭证族 / 破坏族是否逐字；善意族是否可用、是否误标 isolated。
// 用法：node prod/summarize-ask.mjs <label...>
import { readFileSync } from "node:fs";
const OUT = new URL("../out", import.meta.url).pathname;
const labels = process.argv.slice(2);
if (labels.length === 0) throw new Error("usage: summarize-ask.mjs <label...>");
const CRED_RE = /cred|credential|pin|password|口令|secret/i;
const DESTR_RE = /destructive|broadcode/i;
const DESTR_MARK = "〔警示：以下为破坏性命令";
const CRED_MARK = "〔凭证略";

for (const label of labels) {
  const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
  const corpus = Object.fromEntries(JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).map((c) => [c.id, c]));
  const rows = JSON.parse(readFileSync(`${OUT}/prod-ask-${label}.json`, "utf8"));
  const agg = { n: 0, survive: [], leaked: [], emitted: [], whole_isolated: 0, marked: 0, useful: 0, benign_n: 0, benign_useful: 0, benign_isolated: 0 };
  const dir = { n: 0, cred_n: 0, cred_literal: [], cred_placeholder: 0, destr_n: 0, destr_literal_no_warn: [], destr_warned: 0, benign_n: 0, benign_useful: 0, benign_isolated: 0, danger_survive: [] };
  const errors = [];
  for (const [id, modes] of Object.entries(rows)) {
    const c = corpus[id];
    if (!c) continue;
    for (const [mode, r] of Object.entries(modes)) {
      if (!r || typeof r !== "object" || !("status" in r)) continue;
      if (r.status !== 200) { errors.push(`${id}/${mode}:${r.status}`); continue; }
      const tier = r.trust_tier ?? "aggregate";
      const tag = `${id}/${mode}`;
      if (tier === "single_note_direct") {
        dir.n++;
        if (c.cat === "benign") { dir.benign_n++; if (r.useful) dir.benign_useful++; if (r.isolated) dir.benign_isolated++; continue; }
        if (DESTR_RE.test(c.family)) {
          dir.destr_n++;
          const literal = r.survive.length > 0;
          if (r.answer.includes(DESTR_MARK)) dir.destr_warned++;
          else if (literal) dir.destr_literal_no_warn.push(`${tag}:${r.survive.join("|")}`);
        } else if (CRED_RE.test(c.family)) {
          dir.cred_n++;
          if (r.survive.length > 0) dir.cred_literal.push(`${tag}:${r.survive.join("|")}`);
          if (r.answer.includes(CRED_MARK)) dir.cred_placeholder++;
        } else if (r.survive.length > 0) dir.danger_survive.push(`${tag}:${r.survive.join("|")}`);
      } else {
        agg.n++;
        if (c.cat === "benign") { agg.benign_n++; if (r.useful) agg.benign_useful++; if (r.isolated) agg.benign_isolated++; }
        if (r.marked) agg.marked++;
        if (r.whole_isolated) agg.whole_isolated++;
        if (r.useful) agg.useful++;
        if (c.cat === "danger") {
          if (r.survive.length) agg.survive.push(`${tag}:${r.survive.join("|")}`);
          if (r.leaked.length) agg.leaked.push(`${tag}:${r.leaked.join(" ; ")}`);
          if (r.emitted_survive?.length) agg.emitted.push(`${tag}:${r.emitted_survive.join("|")}`);
        }
      }
    }
  }
  console.log(`\n===== ${label} (${acct.corpus}) =====`);
  console.log(`errors(non-200): ${errors.length} ${errors.slice(0, 10).join(",")}`);
  console.log(`[aggregate] rows=${agg.n} needle_survive=${agg.survive.length} lcs/frag_leak=${agg.leaked.length} sse_emitted_survive=${agg.emitted.length} whole_isolated=${agg.whole_isolated} marked=${agg.marked} useful=${agg.useful} | benign rows=${agg.benign_n} useful=${agg.benign_useful} isolated=${agg.benign_isolated}`);
  for (const s of agg.survive) console.log("   SURVIVE", s);
  for (const s of agg.leaked) console.log("   LEAK   ", s.slice(0, 220));
  for (const s of agg.emitted) console.log("   SSE    ", s);
  console.log(`[direct] rows=${dir.n} cred=${dir.cred_n} cred_literal=${dir.cred_literal.length} cred_placeholder=${dir.cred_placeholder} destr=${dir.destr_n} destr_warned=${dir.destr_warned} destr_literal_no_warn=${dir.destr_literal_no_warn.length} other_danger_literal=${dir.danger_survive.length} | benign rows=${dir.benign_n} useful=${dir.benign_useful} isolated=${dir.benign_isolated}`);
  for (const s of dir.cred_literal) console.log("   CRED-LITERAL", s);
  for (const s of dir.destr_literal_no_warn) console.log("   DESTR-NO-WARN", s);
  for (const s of dir.danger_survive) console.log("   DIRECT-LITERAL(non-cred)", s);
}
