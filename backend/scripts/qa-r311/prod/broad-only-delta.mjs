// 观测面差集单次增量核验：读 D1 guard_events 的 outlet_list_broad_only_notes → 对危险账号发 1 次 notes.list →
// 再读一次，增量应恰等于该页里「fold=true 且 contains_executable_command≠true」（宽命中严未命中）的条数。
// 用法（backend/）：CLOUDFLARE_API_TOKEN=... node scripts/qa-r311/prod/broad-only-delta.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { req } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const acct = JSON.parse(readFileSync(`${OUT}/prod-danger-account.json`, "utf8"));
const T = acct.token;
const day = new Date().toISOString().slice(0, 10);

function d1(sql) {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "suinian", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(raw)[0].results;
}
const read = () => {
  const rows = d1(`SELECT kind AS metric, count AS value FROM guard_events WHERE day='${day}' AND kind IN ('outlet_list_broad_only_notes','outlet_list_broad_fold_notes','outlet_list_requests')`);
  return Object.fromEntries(rows.map((r) => [r.metric, r.value]));
};

const before = read();
const r = await req(`/api/notes?limit=100`, { token: T });
const notes = r.json?.notes ?? r.json?.items ?? [];
const broadOnly = notes.filter((n) => n.fold === true && n.contains_executable_command !== true);
const broadAll = notes.filter((n) => n.fold === true);
await new Promise((res) => setTimeout(res, 6000));
const after = read();
const out = {
  day,
  page_notes: notes.length,
  page_fold: broadAll.length,
  page_broad_only: broadOnly.length,
  page_broad_only_ids: broadOnly.map((n) => Object.entries(acct.notes).find(([, v]) => v.note_id === n.id)?.[0] ?? n.id),
  before,
  after,
  delta: Object.fromEntries(Object.keys(after).map((k) => [k, (after[k] ?? 0) - (before[k] ?? 0)])),
};
console.log(JSON.stringify(out, null, 1));
writeFileSync(`${OUT}/broad-only-delta.json`, JSON.stringify(out, null, 1));
