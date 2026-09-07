// R328 生产入库：一个语料一个 [QA-R328] 账号；载体 texts[i] 逐条入库，然后量**数据层标注**（R326 唯一安全开关）。
// 用法：QA_INVITE_CODE=… node prod/seed.mjs <label> <blind|oracle> [danger|benign|all]
//   默认走分拣路径（不带 skip_triage）——R326 架构下标注只来自分拣 + 规则层 + continuation，这是主路径；
//   QA_TRIAGE=0 → skip_triage:true（`!` 直存路径），单独量「`!` 存的凭证是否也会被标注」。
//   gapMs 载体（S05）：texts[0] 先入库，其余 texts 等到 gapMs 之后再入库（打 continuation 30 分钟窗口）。
// 输出：out/prod-<label>-account.json（token/user_id/name，不含密码）、out/prod-<label>-triage.json（逐条标注结果）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep, QA_PREFIX, OUT, needleHits } from "./lib.mjs";

const [label, corpus, catSel = "all"] = process.argv.slice(2);
if (!label || !["blind", "oracle"].includes(corpus)) throw new Error("usage: seed.mjs <label> <blind|oracle> [danger|benign|all]");
const STATE = `${OUT}/prod-${label}-account.json`;
const TRI = `${OUT}/prod-${label}-triage.json`;
const raw = JSON.parse(readFileSync(`${OUT}/${corpus}.json`, "utf8"));
const all = corpus === "oracle" ? raw.map((q) => ({ id: q.id, family: q.family, texts: [q.text], needles: [q.secret], cat: "danger" })) : raw;
const items = all.filter((c) => catSel === "all" || c.cat === catSel);
const triage = process.env.QA_TRIAGE !== "0";

let acct;
if (existsSync(STATE)) {
  acct = JSON.parse(readFileSync(STATE, "utf8"));
  console.log("reuse", acct.name, "carriers", Object.keys(acct.notes).length);
} else {
  acct = await register(`${QA_PREFIX}${label}${Date.now().toString(36).slice(-4)}`);
  acct.notes = {};
  acct.corpus = corpus;
  acct.cat = catSel;
  acct.triage = triage;
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;
const save = () => writeFileSync(STATE, JSON.stringify(acct, null, 1));

async function post(c, i) {
  const r = await postNote(T, c.texts[i], triage ? {} : { skip_triage: true });
  const n = r.note ?? r;
  acct.notes[c.id][i] = { note_id: n.id ?? null, posted_at: Date.now(), fold: n.fold ?? null, fold_reason: n.fold_reason ?? null, sensitive_at_post: n.is_sensitive ?? null };
  save();
  await sleep(triage ? 2500 : 1150);
}

const deferred = [];
for (const c of items) {
  acct.notes[c.id] ??= [];
  for (let i = acct.notes[c.id].length; i < c.texts.length; i++) {
    if (c.gapMs && i > 0) { deferred.push(c); break; }
    await post(c, i);
  }
}
console.log("posted carriers", Object.keys(acct.notes).length, "notes", Object.values(acct.notes).flat().length, deferred.length ? `deferred=${deferred.map((c) => c.id).join(",")}` : "");

const rows = existsSync(TRI) ? JSON.parse(readFileSync(TRI, "utf8")) : {};
async function measure(c, i) {
  const v = acct.notes[c.id][i];
  if (!v?.note_id) return;
  const r = await req(`/api/notes/${v.note_id}`, { token: T });
  const n = r.json?.note ?? r.json ?? {};
  const derived = [n.title, ...(Array.isArray(n.tags) ? n.tags : []), n.summary, n.url_summary].filter(Boolean).join("\n");
  rows[`${c.id}#${i}`] = {
    family: c.family, cat: c.cat, seam: c.seam ?? null, note_id: v.note_id,
    sensitive: n.is_sensitive === true,
    content_placeholder: typeof n.content === "string" && (n.content === "[加密内容]" || n.content.includes("正文已加密")),
    content_raw: needleHits(String(n.content ?? ""), c.needles ?? []).length > 0,
    content_withheld: n.content_withheld === true,
    manual_override: n.manual_override ?? n.meta?.manual_override ?? null,
    continuation: n.meta?.sensitive_continuation ?? n.sensitive_continuation ?? null,
    category: n.category ?? null, title: n.title ?? null, tags: n.tags ?? null, fold: n.fold ?? null, fold_reason: n.fold_reason ?? null,
    derived_leak: needleHits(derived, c.needles ?? []),
  };
  await sleep(300);
}
async function measureAll(list) {
  for (const c of list) for (let i = 0; i < acct.notes[c.id].length; i++) await measure(c, i);
  writeFileSync(TRI, JSON.stringify(rows, null, 1));
}
console.log("waiting 25s for async triage…");
await sleep(25000);
await measureAll(items);

// 延后分片：等 gapMs 到期后再入库其余 texts，再量一次（前后两条都量）
for (const c of deferred) {
  const due = acct.notes[c.id][0].posted_at + c.gapMs;
  const wait = due - Date.now();
  if (wait > 0) { console.log(`${c.id}: waiting ${Math.ceil(wait / 1000)}s for gap window…`); await sleep(wait); }
  for (let i = acct.notes[c.id].length; i < c.texts.length; i++) await post(c, i);
  await sleep(25000);
  await measureAll([c]);
}

// 汇总：危险载体标注率（按族）、正文面（占位 vs 原文）、分拣产物带值；善意误标率
const ks = Object.keys(rows);
const byCat = (cat) => ks.filter((k) => rows[k].cat === cat);
const dk = byCat("danger");
const carrierMarked = (id) => ks.filter((k) => k.startsWith(id + "#")).some((k) => rows[k].sensitive);
const carriers = [...new Set(dk.map((k) => k.split("#")[0]))];
const unmarked = carriers.filter((id) => !carrierMarked(id));
const allNotesMarked = carriers.filter((id) => ks.filter((k) => k.startsWith(id + "#")).every((k) => rows[k].sensitive));
console.log(`[annotation/danger] carriers=${carriers.length} any_note_marked=${carriers.length - unmarked.length} all_notes_marked=${allNotesMarked.length} UNMARKED=${unmarked.length}: ${unmarked.join(",")}`);
console.log(`[annotation/danger notes] n=${dk.length} sensitive=${dk.filter((k) => rows[k].sensitive).length} content_raw_while_sensitive=${dk.filter((k) => rows[k].sensitive && rows[k].content_raw).length} derived_leak=${dk.filter((k) => rows[k].derived_leak.length).map((k) => `${k}[${rows[k].derived_leak.join("|")}]`).join(" ") || 0}`);
const fam = {};
for (const id of carriers) { const f = id.replace(/\d+$/, ""); fam[f] ??= { n: 0, marked: 0 }; fam[f].n++; if (carrierMarked(id)) fam[f].marked++; }
console.log("[annotation/by-family] " + Object.entries(fam).map(([f, v]) => `${f}=${v.marked}/${v.n}`).join(" "));
const bk = byCat("benign");
if (bk.length) {
  const br = bk.filter((k) => /retrieve/.test(rows[k].family));
  const bp = bk.filter((k) => !/retrieve/.test(rows[k].family));
  console.log(`[annotation/benign] n=${bk.length} sensitive=${bk.filter((k) => rows[k].sensitive).length} prose(B)=${bp.filter((k) => rows[k].sensitive).length}/${bp.length} retrieve(BR)=${br.filter((k) => rows[k].sensitive).length}/${br.length} marked: ${bk.filter((k) => rows[k].sensitive).map((k) => k.split("#")[0]).join(",") || "-"}`);
}
