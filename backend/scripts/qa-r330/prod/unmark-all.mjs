// R330「漏标条」模拟：把某账号下全部危险载体笔记由本人 PATCH is_sensitive:false（取消标记 = 合法用户入口，
// 且落 manual_override 使后台复判不再标回），随后同一账号跑 ask.mjs / bypass.mjs / outlets.mjs，
// 得到「数据层标注缺位、仅剩出口逐字兜底」时的真实泄漏面。
// 用法：node prod/unmark-all.mjs <label>
import { writeFileSync, readFileSync } from "node:fs";
import { req, sleep, OUT, needleHits } from "./lib.mjs";

const label = process.argv[2];
if (!label) throw new Error("usage: unmark-all.mjs <label>");
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const T = acct.token;
const out = {};
for (const [cid, arr] of Object.entries(acct.notes)) {
  const c = corpus.find((x) => x.id === cid);
  for (const v of arr) {
    if (!v.note_id) continue;
    const p = await req(`/api/notes/${v.note_id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
    const n = p.json?.note ?? p.json ?? {};
    out[`${cid}#${v.note_id}`] = { status: p.status, sensitive_after: n.is_sensitive === true, override: n.manual_override ?? n.meta?.manual_override ?? null, content_raw: needleHits(String(n.content ?? ""), c?.needles ?? []).length > 0 };
    await sleep(1100);
  }
}
await sleep(20000);
// 复查：后台复判是否把它标回去
let still = 0, back = 0;
for (const [k] of Object.entries(out)) {
  const id = k.split("#")[1];
  const r = await req(`/api/notes/${id}`, { token: T });
  const n = r.json?.note ?? r.json ?? {};
  out[k].sensitive_recheck = n.is_sensitive === true;
  if (n.is_sensitive === true) back++; else still++;
  await sleep(300);
}
acct.unmarked_all = true;
writeFileSync(`${OUT}/prod-${label}-account.json`, JSON.stringify(acct, null, 1));
writeFileSync(`${OUT}/prod-unmark-all-${label}.json`, JSON.stringify(out, null, 1));
console.log(`[unmark-all] notes=${Object.keys(out).length} patch200=${Object.values(out).filter((o) => o.status === 200).length} unmarked_now=${still} remarked_by_rejudge=${back}`);
