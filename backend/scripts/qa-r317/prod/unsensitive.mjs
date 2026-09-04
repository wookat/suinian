// R315：把入库时被敏感闸门自动加密（is_sensitive=1，不入问答）的 QA 笔记按「用户取消敏感标记」路径 PATCH 回 0，
// 使 R314 的凭证折叠/直答收口真正被测到（decision-r314 §P0-2 自述：credential 折叠卡只在用户取消敏感后可见）。
// 同时记录取消前/后的 list 折叠字段，量「敏感闸门先手」与「credential 折叠接手」两道线各覆盖哪些载体。
// 用法：node prod/unsensitive.mjs <label>
import { writeFileSync, readFileSync } from "node:fs";
import { req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const T = acct.token;
const byNoteId = new Map();
for (const [cid, arr] of Object.entries(acct.notes)) arr.forEach((v, i) => byNoteId.set(v.note_id, `${cid}#${i}`));

async function listFold() {
  const rows = {};
  let cursor = null;
  for (let i = 0; i < 12; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    for (const n of r.json?.notes ?? []) {
      const key = byNoteId.get(n.id);
      if (!key) continue;
      rows[key] = { id: n.id, sensitive: n.is_sensitive === true, fold: n.fold === true, fold_reason: n.fold_reason ?? null, strict: n.contains_executable_command === true };
    }
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor) break;
  }
  return rows;
}
const before = await listFold();
const sens = Object.entries(before).filter(([, v]) => v.sensitive);
console.log(`sensitive before: ${sens.length}/${Object.keys(before).length}: ${sens.map(([k]) => k).join(",")}`);
const patch = {};
for (const [key, v] of sens) {
  const r = await req(`/api/notes/${v.id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
  patch[key] = r.status;
  await sleep(1150);
}
const after = await listFold();
const still = Object.entries(after).filter(([, v]) => v.sensitive);
const out = { before, patch, after };
writeFileSync(`${OUT}/prod-${label}-unsensitive.json`, JSON.stringify(out, null, 1));
console.log(`patch statuses: ${JSON.stringify(Object.values(patch).reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}))}`);
console.log(`sensitive after: ${still.length}: ${still.map(([k]) => k).join(",")}`);
const took = sens.filter(([k]) => after[k]?.fold);
console.log(`credential/other fold took over after un-sensitive: ${took.length}/${sens.length}: ${took.map(([k]) => `${k}[${after[k].fold_reason}]`).join(",")}`);
console.log(`neither sensitive nor folded after: ${Object.entries(after).filter(([, v]) => !v.sensitive && !v.fold).map(([k]) => k).join(",")}`);
