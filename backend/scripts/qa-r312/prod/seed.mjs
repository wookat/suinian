// R312 生产入库 + 数据面出口（notes.list fold/fold_reason、search、export json/md、backup 头）。
// 用法：node prod/seed.mjs <label> <carriers|benign> [fromIdx] [toIdx]
//   label 形如 da/db/b → 账号 [QA-R312]<label>…；密码运行时随机、不落盘（本地 out/ 状态只存 token，且 gitignore）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep, QA_PREFIX } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const [label, corpus, fromS, toS] = process.argv.slice(2);
if (!label || (corpus !== "carriers" && corpus !== "benign")) throw new Error("usage: seed.mjs <label> <carriers|benign> [from] [to]");
const STATE = `${OUT}/prod-${label}-account.json`;
const all = JSON.parse(readFileSync(`${OUT}/${corpus}.json`, "utf8"));
const items = all.slice(Number(fromS ?? 0), toS ? Number(toS) : undefined);

let acct;
if (existsSync(STATE)) {
  acct = JSON.parse(readFileSync(STATE, "utf8"));
  console.log("reuse", acct.name, "notes", Object.keys(acct.notes).length);
} else {
  acct = await register(`${QA_PREFIX}${label}${Date.now().toString(36).slice(-4)}`);
  delete acct.password;
  acct.notes = {};
  acct.corpus = corpus;
  acct.range = [Number(fromS ?? 0), toS ? Number(toS) : all.length];
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;
for (const c of items) {
  if (acct.notes[c.id]) continue;
  const n = await postNote(T, c.text, { skip_triage: true });
  acct.notes[c.id] = { note_id: n.note?.id ?? n.id ?? null, fold_on_create: n.note?.fold ?? null, fold_reason_on_create: n.note?.fold_reason ?? null };
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  await sleep(1150);
}
console.log("posted", Object.keys(acct.notes).length);

const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const rows = Object.fromEntries(items.map((c) => [c.id, { family: c.family, cat: c.cat ?? "reg", note_id: acct.notes[c.id].note_id }]));
{
  let cursor = null;
  for (let i = 0; i < 12; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    for (const n of r.json?.notes ?? []) {
      const id = byNoteId.get(n.id);
      if (!id || !rows[id]) continue; // 复用账号里不在本次区间的旧笔记跳过
      rows[id].list_strict = n.contains_executable_command === true;
      rows[id].list_fold = n.fold === true;
      rows[id].list_fold_reason = n.fold_reason ?? null;
      rows[id].list_title = n.title ?? null;
      rows[id].list_sensitive = n.is_sensitive === true;
    }
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor) break;
  }
}
for (const c of items) {
  const q = Array.from(c.text.replace(/\s+/g, " ")).slice(0, 10).join("").replace(/[\uD800-\uDFFF]/g, "");
  const r = await req(`/api/notes?q=${encodeURIComponent(q)}&limit=50`, { token: T });
  const hit = (r.json?.notes ?? []).find((n) => n.id === rows[c.id].note_id);
  rows[c.id].search_fold = hit ? hit.fold === true : null;
  rows[c.id].search_fold_reason = hit ? hit.fold_reason ?? null : null;
  await sleep(120);
}
{
  const md = await req(`/api/export?format=md`, { token: T, raw: true });
  writeFileSync(`${OUT}/prod-${label}-export.md`, md.text);
  const js = await req(`/api/export`, { token: T });
  writeFileSync(`${OUT}/prod-${label}-export.json`, js.text);
  const bk = await req(`/api/backup`, { token: T, raw: true });
  rows.__global = {
    md_header: md.headers.get("x-suinian-content-risk"),
    md_ai_notice: /AI 聚合文本|聚合层强收口/.test(md.text.slice(0, 3000)),
    json_header: js.headers.get("x-suinian-content-risk"),
    json_ai_derived: js.json?.ai_derived ?? null,
    backup_status: bk.status,
    backup_header: bk.headers.get("x-suinian-content-risk"),
  };
  const jsNotes = new Map((js.json?.notes ?? []).map((n) => [n.id, n]));
  for (const c of items) {
    const n = jsNotes.get(rows[c.id].note_id);
    rows[c.id].export_json_fold = n ? n.fold === true : null;
    rows[c.id].export_json_fold_reason = n ? n.fold_reason ?? null : null;
  }
}
writeFileSync(`${OUT}/prod-${label}-outlets.json`, JSON.stringify(rows, null, 1));

const ids = items.map((c) => c.id);
const byCat = {};
for (const c of items) (byCat[c.cat ?? "reg"] ??= []).push(c.id);
const DEFAULT_FOLD = (r) => r && r !== "broad:code";
for (const [cat, cids] of Object.entries(byCat)) {
  const fold = cids.filter((id) => rows[id].list_fold === true);
  const foldDefault = cids.filter((id) => rows[id].list_fold === true && DEFAULT_FOLD(rows[id].list_fold_reason));
  const code = cids.filter((id) => rows[id].list_fold_reason === "broad:code");
  const strict = cids.filter((id) => rows[id].list_strict === true);
  const sens = cids.filter((id) => rows[id].list_sensitive);
  const incons = cids.filter((id) => rows[id].search_fold !== null && rows[id].search_fold !== rows[id].list_fold);
  const inconsE = cids.filter((id) => rows[id].export_json_fold !== null && rows[id].export_json_fold !== rows[id].list_fold);
  console.log(
    `[${corpus}/${cat}] n=${cids.length} fold=${fold.length} (${((100 * fold.length) / cids.length).toFixed(1)}%) default_fold=${foldDefault.length} (${((100 * foldDefault.length) / cids.length).toFixed(1)}%) broad:code=${code.length} strict=${strict.length} sensitive=${sens.length} list≠search=${incons.length} list≠export=${inconsE.length}`
  );
  if (corpus === "benign" && fold.length) console.log(`  折叠: ${fold.map((id) => `${id}[${rows[id].list_fold_reason}]`).join(",")}`);
}
console.log("global:", JSON.stringify(rows.__global));
