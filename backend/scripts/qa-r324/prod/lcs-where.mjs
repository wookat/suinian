// 诊断：某个出口的原始文本与语料原文的最长公共子串落在哪（是不是 notes[] 里非受守笔记自身的原文回传）。
// 用法：node prod/lcs-where.mjs <label> <mcp-tool> [question]
import { readFileSync } from "node:fs";
import { mcpCall, OUT } from "./lib.mjs";

const [label, tool, question] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).filter((c) => acct.notes[c.id]);
const STRIP = /[\s\p{P}\p{S}]+/gu;
const n2 = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(STRIP, "");
const r = await mcpCall(acct.token, tool, question ? { question } : {});
const raw = n2(r.text);
const dataLine = r.text.split(/\r?\n/).find((l) => l.startsWith("data:"));
const rpc = JSON.parse(dataLine.slice(5).trim());
const body = JSON.parse(rpc.result.content.find((c) => c.type === "text").text);
console.log("answer:", body.answer);
for (const n of body.notes ?? []) console.log("note:", n.id, "guarded=", n.guarded, n.guard_kind ?? "", JSON.stringify(n.title), JSON.stringify(n.content).slice(0, 120));
for (const c of corpus) {
  for (const t of c.texts) {
    const x = n2(t);
    let best = "";
    for (let i = 0; i < x.length; i++) for (let len = Math.min(64, x.length - i); len >= 8; len--) { const p = x.slice(i, i + len); if (raw.includes(p)) { if (p.length > best.length) best = p; break; } }
    if (best.length >= 8) console.log(`lcs ${best.length} ${c.id} [${c.cat}] «${best}»  in answer? ${n2(body.answer).includes(best)}`);
  }
}
