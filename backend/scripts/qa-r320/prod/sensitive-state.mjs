// R319：列出某个 QA 账号里每条载体笔记的当前 is_sensitive / fold / fold_reason（分拣异步完成后再看一次），
// 用于量「默认分拣路径（QA_TRIAGE=1 入库）」把多少凭证/破坏载体自动标敏感或折叠。
// 用法：node prod/sensitive-state.mjs <label>
import { readFileSync, writeFileSync } from "node:fs";
import { req } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
if (!label) throw new Error("usage: sensitive-state.mjs <label>");
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = new Map(JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).map((c) => [c.id, c]));
const byNoteId = new Map();
for (const [cid, arr] of Object.entries(acct.notes)) arr.forEach((v, i) => byNoteId.set(v.note_id, `${cid}#${i}`));
const rows = {};
let cursor = null;
for (let i = 0; i < 12; i++) {
  const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: acct.token });
  for (const n of r.json?.notes ?? []) {
    const key = byNoteId.get(n.id);
    if (!key) continue;
    rows[key] = { sensitive: n.is_sensitive === true, fold: n.fold === true, fold_reason: n.fold_reason ?? null, category: n.category ?? null, needs_retriage: n.needs_retriage ?? null };
  }
  cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
  if (!cursor) break;
}
writeFileSync(`${OUT}/prod-${label}-sensitive.json`, JSON.stringify(rows, null, 1));
const fam = (k) => String(corpus.get(k.split("#")[0])?.family ?? "").split("-")[0];
for (const f of ["cred", "destructive", "benign"]) {
  const ks = Object.keys(rows).filter((k) => fam(k) === f);
  if (!ks.length) continue;
  const sens = ks.filter((k) => rows[k].sensitive);
  const fold = ks.filter((k) => !rows[k].sensitive && rows[k].fold);
  const bare = ks.filter((k) => !rows[k].sensitive && !rows[k].fold);
  console.log(`[${label}/${f}] notes=${ks.length} sensitive=${sens.length} fold(non-sensitive)=${fold.length} bare=${bare.length}`);
  console.log(`  sensitive: ${sens.join(",")}`);
  console.log(`  fold: ${fold.map((k) => `${k}[${rows[k].fold_reason}]`).join(",")}`);
  console.log(`  bare: ${bare.join(",")}`);
}
