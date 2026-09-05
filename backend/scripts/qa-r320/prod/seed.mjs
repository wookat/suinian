// R320 生产（R319 副本）入库：一个语料一个 [QA-R320] 账号；多条笔记载体逐条入库（每条 texts[i] 一条笔记）。
// 同时记录数据面出口的折叠字段（notes.list fold/fold_reason、search、export json）以量 broad:code 展示率。
// 用法：node prod/seed.mjs <label> <blind|r317blind|r318new|informed> [danger|benign|all]
//   QA_TRIAGE=1 → 不带 skip_triage（走默认分拣管道：模型 + detectSensitive 兜底可能把凭证笔记自动标敏感/加密），
//   用于量「默认路径」相对 skip_triage 上界的额外一层；R317/R318 历史基线均为 skip_triage 口径。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep, QA_PREFIX } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const [label, corpus, catSel = "all"] = process.argv.slice(2);
if (!label || !["blind","r317blind","r318new","informed","echo"].includes(corpus)) throw new Error("usage: seed.mjs <label> <blind|r317blind|r318new|informed|echo> [danger|benign|all]");
const STATE = `${OUT}/prod-${label}-account.json`;
const all = JSON.parse(readFileSync(`${OUT}/${corpus}.json`, "utf8"));
const items = all.filter((c) => catSel === "all" || c.cat === catSel);

let acct;
if (existsSync(STATE)) {
  acct = JSON.parse(readFileSync(STATE, "utf8"));
  console.log("reuse", acct.name, "carriers", Object.keys(acct.notes).length);
} else {
  acct = await register(`${QA_PREFIX}${label}${Date.now().toString(36).slice(-4)}`);
  delete acct.password;
  acct.notes = {};
  acct.corpus = corpus;
  acct.cat = catSel;
  acct.triage = process.env.QA_TRIAGE === "1";
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;
for (const c of items) {
  acct.notes[c.id] ??= [];
  for (let i = acct.notes[c.id].length; i < c.texts.length; i++) {
    const n = await postNote(T, c.texts[i], process.env.QA_TRIAGE === "1" ? {} : { skip_triage: true });
    acct.notes[c.id][i] = { note_id: n.note?.id ?? n.id ?? null, fold_on_create: n.note?.fold ?? null, fold_reason_on_create: n.note?.fold_reason ?? null };
    writeFileSync(STATE, JSON.stringify(acct, null, 1));
    await sleep(1150);
  }
}
console.log("posted carriers", Object.keys(acct.notes).length, "notes", Object.values(acct.notes).flat().length);

// 数据面折叠字段
const byNoteId = new Map();
for (const [cid, arr] of Object.entries(acct.notes)) arr.forEach((v, i) => byNoteId.set(v.note_id, `${cid}#${i}`));
const rows = {};
{
  let cursor = null;
  for (let i = 0; i < 12; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    for (const n of r.json?.notes ?? []) {
      const key = byNoteId.get(n.id);
      if (!key) continue;
      rows[key] = { list_strict: n.contains_executable_command === true, list_fold: n.fold === true, list_fold_reason: n.fold_reason ?? null, list_sensitive: n.is_sensitive === true };
    }
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor) break;
  }
}
{
  const js = await req(`/api/export`, { token: T });
  writeFileSync(`${OUT}/prod-${label}-export.json`, js.text);
  const md = await req(`/api/export?format=md`, { token: T, raw: true });
  writeFileSync(`${OUT}/prod-${label}-export.md`, md.text);
  const bk = await req(`/api/backup`, { token: T, raw: true });
  rows.__global = {
    json_header: js.headers.get("x-suinian-content-risk"),
    json_ai_derived: js.json?.ai_derived ?? null,
    md_header: md.headers.get("x-suinian-content-risk"),
    md_ai_notice: /AI 聚合文本|聚合层强收口|不逐字转写/.test(md.text.slice(0, 4000)),
    backup_status: bk.status,
    backup_header: bk.headers.get("x-suinian-content-risk"),
  };
  const jsNotes = new Map((js.json?.notes ?? []).map((n) => [n.id, n]));
  for (const [nid, key] of byNoteId) {
    const n = jsNotes.get(nid);
    if (rows[key]) rows[key].export_fold = n ? n.fold === true : null;
  }
}
writeFileSync(`${OUT}/prod-${label}-datafold.json`, JSON.stringify(rows, null, 1));
const keys = Object.keys(rows).filter((k) => k !== "__global");
for (const cat of ["danger", "benign"]) {
  const ks = keys.filter((k) => items.find((c) => c.id === k.split("#")[0])?.cat === cat);
  if (!ks.length) continue;
  const fold = ks.filter((k) => rows[k].list_fold);
  const def = ks.filter((k) => rows[k].list_fold && rows[k].list_fold_reason !== "broad:code");
  const code = ks.filter((k) => rows[k].list_fold_reason === "broad:code");
  const strict = ks.filter((k) => rows[k].list_strict);
  const incons = ks.filter((k) => rows[k].export_fold !== null && rows[k].export_fold !== rows[k].list_fold);
  console.log(`[${corpus}/${cat}] notes=${ks.length} fold=${fold.length} (${((100 * fold.length) / ks.length).toFixed(1)}%) default_fold=${def.length} (${((100 * def.length) / ks.length).toFixed(1)}%) broad:code=${code.length} strict=${strict.length} list≠export=${incons.length}`);
  console.log(`  fold: ${fold.map((k) => `${k}[${rows[k].list_fold_reason}]`).join(",")}`);
}
console.log("global:", JSON.stringify(rows.__global));
