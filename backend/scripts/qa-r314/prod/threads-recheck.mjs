// R313：线索标题/摘要复查（outlets.mjs 里 rebuild 轮询超时后，线索仍会在后台继续生成标题/摘要；
// 本脚本只重新拉 /api/threads + MCP list_threads，按 needles / LCS8 / 整行三口径复算）。用法：node prod/threads-recheck.mjs <label>
import { writeFileSync, readFileSync } from "node:fs";
import { req, mcpCall } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const items = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"))
  .filter((c) => acct.notes[c.id])
  .flatMap((c) => c.texts.map((t, i) => ({ id: `${c.id}#${i}`, text: t, needles: c.needles ?? [], cat: c.cat })));
const T = acct.token;
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const srcs = items.map((c) => ({ id: c.id, n: norm(c.text), lines: c.text.split("\n").map((l) => ({ line: l.trim(), n: norm(l) })).filter((l) => l.n.length >= 4) }));
function lcsLen(a, b) {
  if (!a || !b) return 0;
  let prev = new Uint16Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) if (ca === b.charCodeAt(j - 1)) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
function overlap(text) {
  const a = norm(String(text ?? "").replace(/〔[^〕]*〕/g, ""));
  const out = { lcs8: [], lines: [], needles: [] };
  const rawT = String(text ?? "");
  for (const it of items) if (it.cat === "danger") for (const n of it.needles) if (norm(n).length ? a.includes(norm(n)) : rawT.includes(n)) out.needles.push(`${it.id}:${n}`);
  if (a.length < 8) return out;
  for (const s of srcs) {
    for (const l of s.lines) if (a.includes(l.n)) out.lines.push(`${s.id}:${l.line.slice(0, 40)}`);
    const len = lcsLen(a, s.n);
    if (len >= 8) out.lcs8.push(`${s.id}:${len}`);
  }
  return out;
}
const check = (list) => {
  const r = { n: list.length, untitled: 0, title_hits: [], summary_hits: [], samples: [] };
  for (const t of list) {
    const to = overlap(t.title), so = overlap(t.summary);
    if (/未命名线索/.test(t.title ?? "")) r.untitled++;
    if (to.lcs8.length || to.lines.length || to.needles.length) r.title_hits.push({ title: t.title, ...to });
    if (so.lcs8.length || so.lines.length || so.needles.length) r.summary_hits.push({ summary: String(t.summary).slice(0, 200), ...so });
    if (r.samples.length < 20) r.samples.push({ title: t.title, summary: String(t.summary ?? "").slice(0, 120) });
  }
  return r;
};
const th = await req("/api/threads", { token: T });
const rest = check(th.json?.threads ?? []);
const lt = await mcpCall(T, "list_threads", {});
let ltj = null;
try {
  const text = lt.text;
  const env = JSON.parse(text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
  const inner = env?.result?.content?.[0]?.text;
  ltj = inner ? JSON.parse(inner) : env;
} catch {}
const mcp = check(ltj?.threads ?? []);
const out = { label, at: new Date().toISOString(), rest, mcp_list_threads: mcp };
writeFileSync(`${OUT}/prod-${label}-threads-recheck.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ rest: { ...rest, samples: undefined }, mcp: { ...mcp, samples: undefined } }, null, 1));
