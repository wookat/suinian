// 善意语料写入独立 [QA-R306] 账号，核对数据面误标（notes.list / search / export）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const STATE = `${OUT}/prod-benign-account.json`;
const items = JSON.parse(readFileSync(`${OUT}/benign.json`, "utf8"));

let acct;
if (existsSync(STATE)) acct = JSON.parse(readFileSync(STATE, "utf8"));
else {
  acct = await register(`[QA-R306]b${Date.now().toString(36).slice(-5)}`);
  acct.notes = {};
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;
for (const c of items) {
  if (acct.notes[c.id]) continue;
  const n = await postNote(T, c.text, { skip_triage: true });
  acct.notes[c.id] = { note_id: n.note?.id ?? n.id ?? null, flag_on_create: n.note?.contains_executable_command ?? null };
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  await sleep(1150);
}
console.log("posted", Object.keys(acct.notes).length);

const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const rows = Object.fromEntries(items.map((c) => [c.id, { family: c.family, note_id: acct.notes[c.id].note_id }]));
let cursor = null;
for (let i = 0; i < 10; i++) {
  const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
  for (const n of r.json?.notes ?? []) {
    const id = byNoteId.get(n.id);
    if (id) {
      rows[id].list = n.contains_executable_command === true;
      rows[id].sensitive = n.is_sensitive === true;
    }
  }
  cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
  if (!cursor) break;
}
const js = await req(`/api/export`, { token: T });
const jsNotes = new Map((js.json?.notes ?? []).map((n) => [n.id, n]));
for (const c of items) rows[c.id].export_json = jsNotes.get(rows[c.id].note_id)?.contains_executable_command === true;
writeFileSync(`${OUT}/prod-benign-outlets.json`, JSON.stringify(rows, null, 1));
const flagged = items.filter((c) => rows[c.id].list === true).map((c) => c.id);
const sens = items.filter((c) => rows[c.id].sensitive).map((c) => c.id);
console.log(`善意数据面误标 ${flagged.length}/${items.length} = ${((flagged.length / items.length) * 100).toFixed(2)}%: ${flagged.join(",")}`);
console.log(`被判敏感 ${sens.length}: ${sens.join(",")}`);
