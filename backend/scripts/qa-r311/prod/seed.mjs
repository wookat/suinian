// R311 生产入库 + 数据面出口（notes.list / search / export json+md / backup 头）矩阵。
// 用法：node prod/seed.mjs <danger|benign>     账号名 [QA-R311]d…/b…，密码运行时随机，只落本地 out/（gitignore）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const kind = process.argv[2];
if (kind !== "danger" && kind !== "benign") throw new Error("usage: seed.mjs <danger|benign>");
const STATE = `${OUT}/prod-${kind}-account.json`;
const items = JSON.parse(readFileSync(`${OUT}/${kind === "danger" ? "carriers" : "benign"}.json`, "utf8"));

let acct;
if (existsSync(STATE)) {
  acct = JSON.parse(readFileSync(STATE, "utf8"));
  console.log("reuse", acct.name, "notes", Object.keys(acct.notes).length);
} else {
  acct = await register(`[QA-R311]${kind[0]}${Date.now().toString(36).slice(-5)}`);
  acct.notes = {};
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;
for (const c of items) {
  if (acct.notes[c.id]) continue;
  const n = await postNote(T, c.text, { skip_triage: true });
  acct.notes[c.id] = { note_id: n.note?.id ?? n.id ?? null, flag_on_create: n.note?.contains_executable_command ?? null, fold_on_create: n.note?.fold ?? null };
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  await sleep(1150);
}
console.log("posted", Object.keys(acct.notes).length);

const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const rows = Object.fromEntries(items.map((c) => [c.id, { family: c.family, cat: c.cat ?? "reg", note_id: acct.notes[c.id].note_id }]));
// notes.list
{
  let cursor = null;
  for (let i = 0; i < 12; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    for (const n of r.json?.notes ?? []) {
      const id = byNoteId.get(n.id);
      if (!id) continue;
      rows[id].list_strict = n.contains_executable_command === true;
      rows[id].list_fold = n.fold === true;
      rows[id].list_fold_reason = n.fold_reason ?? null;
      rows[id].list_title = n.title ?? null;
      rows[id].list_sensitive = n.is_sensitive === true;
    }
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor) break;
  }
  rows.__list_headers = { risk: null };
  const r0 = await req(`/api/notes?limit=5`, { token: T, raw: true });
  rows.__list_headers.risk = r0.headers.get("x-suinian-content-risk");
}
// search
for (const c of items) {
  const q = Array.from(c.text.replace(/\s+/g, " ")).slice(0, 10).join("").replace(/[\uD800-\uDFFF]/g, "");
  const r = await req(`/api/notes?q=${encodeURIComponent(q)}&limit=50`, { token: T });
  const hit = (r.json?.notes ?? []).find((n) => n.id === rows[c.id].note_id);
  rows[c.id].search_fold = hit ? hit.fold === true : null;
  rows[c.id].search_snippet_raw = hit ? (typeof hit.snippet === "string" ? hit.snippet : null) : null;
  await sleep(120);
}
// export md/json + backup 头
{
  const md = await req(`/api/export?format=md`, { token: T, raw: true });
  writeFileSync(`${OUT}/prod-${kind}-export.md`, md.text);
  const js = await req(`/api/export`, { token: T });
  writeFileSync(`${OUT}/prod-${kind}-export.json`, js.text);
  const bk = await req(`/api/backup`, { token: T, raw: true });
  rows.__global = {
    md_header: md.headers.get("x-suinian-content-risk"),
    md_notice: /不保证逐条识别每一种危险内容/.test(md.text.slice(0, 2000)),
    json_header: js.headers.get("x-suinian-content-risk"),
    json_notice: typeof (js.json?.content_risk ?? js.json?.content_risk_notice) === "string" || (js.json?.content_risk && typeof js.json.content_risk === "object"),
    backup_status: bk.status,
    backup_header: bk.headers.get("x-suinian-content-risk"),
  };
  const jsNotes = new Map((js.json?.notes ?? []).map((n) => [n.id, n]));
  for (const c of items) {
    const n = jsNotes.get(rows[c.id].note_id);
    rows[c.id].export_json_fold = n ? n.fold === true : null;
    const idx = md.text.indexOf(`（${rows[c.id].note_id}）`);
    if (idx >= 0) {
      const next = md.text.indexOf("\n### ", idx);
      const block = md.text.slice(idx, next < 0 ? undefined : next);
      rows[c.id].export_md_warn = /含可执行命令\/危险指令|已折叠|勿直接执行/.test(block);
    } else rows[c.id].export_md_warn = null;
  }
}
writeFileSync(`${OUT}/prod-${kind}-outlets.json`, JSON.stringify(rows, null, 1));

const ids = items.map((c) => c.id);
const byCat = {};
for (const c of items) (byCat[c.cat ?? "reg"] ??= []).push(c.id);
for (const [cat, cids] of Object.entries(byCat)) {
  const fold = cids.filter((id) => rows[id].list_fold === true);
  const strict = cids.filter((id) => rows[id].list_strict === true);
  const sens = cids.filter((id) => rows[id].list_sensitive);
  const sFold = cids.filter((id) => rows[id].search_fold === true);
  const eFold = cids.filter((id) => rows[id].export_json_fold === true);
  const mdW = cids.filter((id) => rows[id].export_md_warn === true);
  console.log(`[${kind}/${cat}] n=${cids.length} list.fold=${fold.length} (${((100 * fold.length) / cids.length).toFixed(1)}%) strict=${strict.length} sensitive=${sens.length} search.fold=${sFold.length} export.json.fold=${eFold.length} export.md.warn=${mdW.length}`);
  if (kind === "danger") console.log(`  未折叠: ${cids.filter((id) => rows[id].list_fold !== true && !rows[id].list_sensitive).join(",")}`);
  else console.log(`  折叠: ${fold.map((id) => `${id}[${rows[id].list_fold_reason}]`).join(",")}`);
}
console.log("global:", JSON.stringify(rows.__global), "list-risk-header:", rows.__list_headers.risk);
const titleLeak = ids.filter((id) => rows[id].list_fold && rows[id].list_title && !/已折叠|含端点|含可执行/.test(rows[id].list_title));
console.log("折叠条标题非占位:", titleLeak.length, titleLeak.map((id) => `${id}:${rows[id].list_title}`).slice(0, 20).join(" | "));
