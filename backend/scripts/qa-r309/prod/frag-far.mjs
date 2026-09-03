// R309：分片「非邻近」生产复测——R308 自报分片按「同账号邻近笔记拼接后再判」
// （exec-fragments.ts FRAG_REJUDGE_RECENT=12）。这里用本地/生产**邻近时能判出**的分片组
// （R18 三片、NC01 四片）作对照：每两片之间插 20 条无关笔记，看生产是否仍能标出。
// 用法：node prod/frag-far.mjs（自建 [QA-R309] 账号；测完由 cleanup.mjs 统一注销）
import { writeFileSync, readFileSync } from "node:fs";
import { register, postNote, req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const carriers = JSON.parse(readFileSync(`${OUT}/carriers.json`, "utf8"));
const benign = JSON.parse(readFileSync(`${OUT}/benign.json`, "utf8"));
const fillers = benign.filter((b) => b.cat === "reg" && b.text.length < 80).slice(0, 60);
const GROUPS = { R18: ["R18a", "R18b", "R18c"], NC01: ["NC01a", "NC01b", "NC01c", "NC01d"] };

const acct = await register(`[QA-R309]ff${Date.now().toString(36).slice(-4)}`);
acct.notes = {};
const STATE = `${OUT}/prod-fragfar-account.json`;
writeFileSync(STATE, JSON.stringify(acct, null, 1));
const T = acct.token;
let fi = 0;
const post = async (id, text) => {
  const n = await postNote(T, text, { skip_triage: true });
  acct.notes[id] = { note_id: n.note?.id ?? n.id ?? null, flag_on_create: n.note?.contains_executable_command ?? null };
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  await sleep(1150);
};
for (const [g, ids] of Object.entries(GROUPS)) {
  for (let k = 0; k < ids.length; k++) {
    if (k > 0) for (let j = 0; j < 20; j++) await post(`${g}-filler-${k}-${j}`, fillers[fi++ % fillers.length].text);
    await post(ids[k], carriers.find((c) => c.id === ids[k]).text);
  }
}
// 写完后等 20s（异步复判有机会落库），再拉 list 核对
await sleep(20000);
const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const flags = {};
let cursor = null;
for (let i = 0; i < 10; i++) {
  const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
  for (const n of r.json?.notes ?? []) {
    const id = byNoteId.get(n.id);
    if (id) flags[id] = n.contains_executable_command === true;
  }
  cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
  if (!cursor) break;
}
const summary = {};
for (const [g, ids] of Object.entries(GROUPS)) {
  summary[g] = {
    frags: Object.fromEntries(ids.map((id) => [id, { create: acct.notes[id].flag_on_create, list: flags[id] ?? null }])),
    fillersFlagged: Object.entries(flags).filter(([id, f]) => id.startsWith(`${g}-filler`) && f).map(([id]) => id),
  };
}
console.log(JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/prod-fragfar.json`, JSON.stringify({ summary, flags }, null, 1));
