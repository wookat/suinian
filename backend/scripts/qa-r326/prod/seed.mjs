// R326 生产入库：一个语料一个 [QA-R326] 账号；载体 texts[i] 逐条入库。
// 用法：QA_INVITE_CODE=… node prod/seed.mjs <label> <blind|informed|oracle> [danger|benign|all]
//   QA_TRIAGE=1 → 不带 skip_triage（默认分拣路径，量分拣模型对危险载体的自动标敏感/加密与标题/标签是否带出取值）；
//   默认 skip_triage:true（`!` 路径，R321 14/32 泄漏的历史入口）。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, sleep, QA_PREFIX, OUT, needleHits } from "./lib.mjs";

const [label, corpus, catSel = "all"] = process.argv.slice(2);
if (!label || !["blind", "informed", "oracle"].includes(corpus)) throw new Error("usage: seed.mjs <label> <blind|informed|oracle> [danger|benign|all]");
const STATE = `${OUT}/prod-${label}-account.json`;
const raw = JSON.parse(readFileSync(`${OUT}/${corpus}.json`, "utf8"));
// oracle.json 是 Q 族（text/secret），统一成 texts/needles 形态
const all = corpus === "oracle" ? raw.map((q) => ({ id: q.id, family: q.family, texts: [q.text], needles: [q.secret], cat: "danger" })) : raw;
const items = all.filter((c) => catSel === "all" || c.cat === catSel);
const triage = process.env.QA_TRIAGE === "1";

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
for (const c of items) {
  acct.notes[c.id] ??= [];
  for (let i = acct.notes[c.id].length; i < c.texts.length; i++) {
    const r = await postNote(T, c.texts[i], triage ? {} : { skip_triage: true });
    const n = r.note ?? r;
    acct.notes[c.id][i] = { note_id: n.id ?? null, fold: n.fold ?? null, fold_reason: n.fold_reason ?? null, sensitive: n.is_sensitive ?? null, title: n.title ?? null, tags: n.tags ?? null };
    writeFileSync(STATE, JSON.stringify(acct, null, 1));
    await sleep(triage ? 2500 : 1150);
  }
}
console.log("posted carriers", Object.keys(acct.notes).length, "notes", Object.values(acct.notes).flat().length);

// 分拣路径：等分拣落库后重新拉一遍，量 title/tags/summary 是否带出取值（分拣入口旁通）
if (triage) {
  await sleep(15000);
  const rows = {};
  for (const c of items) {
    for (const [i, v] of acct.notes[c.id].entries()) {
      if (!v.note_id) continue;
      const r = await req(`/api/notes/${v.note_id}`, { token: T });
      const n = r.json?.note ?? r.json ?? {};
      const derived = [n.title, ...(Array.isArray(n.tags) ? n.tags : []), n.summary, n.url_summary].filter(Boolean).join("\n");
      rows[`${c.id}#${i}`] = { sensitive: n.is_sensitive === true, content_placeholder: n.content === "[加密内容]" || n.content_enc != null, title: n.title ?? null, tags: n.tags ?? null, fold: n.fold ?? null, fold_reason: n.fold_reason ?? null, derived_leak: needleHits(derived, c.needles ?? []) };
      await sleep(300);
    }
  }
  writeFileSync(`${OUT}/prod-${label}-triage.json`, JSON.stringify(rows, null, 1));
  const ks = Object.keys(rows);
  const dk = ks.filter((k) => items.find((c) => c.id === k.split("#")[0])?.cat === "danger");
  console.log(`[triage/danger] n=${dk.length} sensitive=${dk.filter((k) => rows[k].sensitive).length} fold=${dk.filter((k) => rows[k].fold).length} derived_leak=${dk.filter((k) => rows[k].derived_leak.length).length} ${dk.filter((k) => rows[k].derived_leak.length).map((k) => `${k}[${rows[k].derived_leak.join("|")}]`).join(" ")}`);
  const bk = ks.filter((k) => items.find((c) => c.id === k.split("#")[0])?.cat === "benign");
  if (bk.length) console.log(`[triage/benign] n=${bk.length} sensitive=${bk.filter((k) => rows[k].sensitive).length} fold=${bk.filter((k) => rows[k].fold).length}`);
}
