// R326 预言机「真 0 bit」实测：两个账号 A/B 入同一组 Q 族笔记，唯独秘密值不同（同长度/同字符类形态换值），
// 对两账号发完全相同的 T/F 问句；答案（剔角标/空白/标点归一化）与引用条数在 A/B 间若逐题相同 ⇒ 答案与秘密值无关 = 0 bit。
// 这是对 oracle.mjs「T/F 同账号比较」上界口径的补充：后者 T/F 问句本身不同（如 Q02 四组 vs 三组），差异可能来自问句形态而非秘密。
// 用法：QA_INVITE_CODE=… node prod/oracle-pair.mjs <label>
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { ask, register, postNote, req, sleep, QA_PREFIX, OUT, norm } from "./lib.mjs";

const label = process.argv[2];
if (!label) throw new Error("usage: oracle-pair.mjs <label>");
const Q = JSON.parse(readFileSync(`${OUT}/oracle.json`, "utf8"));
const STATE = `${OUT}/prod-${label}-pair-account.json`;
const RES = `${OUT}/prod-oracle-pair-${label}.json`;

// 同形态换值：数字→数字、大写→大写、小写→小写、符号→符号、汉字→汉字（保长度与字符类序列，只改具体值）
const ALT = { "0": "7", "1": "5", "2": "9", "3": "1", "4": "8", "5": "2", "6": "3", "7": "0", "8": "6", "9": "4" };
const swap = (ch) => {
  if (ALT[ch]) return ALT[ch];
  if (/[A-Z]/.test(ch)) return String.fromCharCode(65 + ((ch.charCodeAt(0) - 65 + 11) % 26));
  if (/[a-z]/.test(ch)) return String.fromCharCode(97 + ((ch.charCodeAt(0) - 97 + 11) % 26));
  if (/[\u4e00-\u9fff]/.test(ch)) return "青松岭上三号木门东"[(ch.charCodeAt(0) % 9)];
  if (ch === "#") return "@";
  if (ch === "@") return "#";
  if (ch === "&") return "%";
  return ch;
};
const altSecret = (s) => [...s].map(swap).join("");

let st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
if (!st) {
  const tag = Date.now().toString(36).slice(-4);
  const A = await register(`${QA_PREFIX}${label}pa${tag}`);
  const B = await register(`${QA_PREFIX}${label}pb${tag}`);
  st = { A: { ...A, notes: {} }, B: { ...B, notes: {} }, alt: {} };
  writeFileSync(STATE, JSON.stringify(st, null, 1));
  console.log("registered", A.name, A.user_id, "/", B.name, B.user_id);
}
for (const q of Q) {
  const alt = altSecret(q.secret);
  st.alt[q.id] = alt;
  if (!st.A.notes[q.id]) {
    const r = await postNote(st.A.token, q.text, { skip_triage: true });
    st.A.notes[q.id] = (r.note ?? r).id ?? null;
    writeFileSync(STATE, JSON.stringify(st, null, 1));
    await sleep(1150);
  }
  if (!st.B.notes[q.id]) {
    const r = await postNote(st.B.token, q.text.replace(q.secret, alt), { skip_triage: true });
    st.B.notes[q.id] = (r.note ?? r).id ?? null;
    writeFileSync(STATE, JSON.stringify(st, null, 1));
    await sleep(1150);
  }
}
console.log("seeded A/B", Object.keys(st.A.notes).length, "notes each; waiting for triage…");
await sleep(20000);

// R326：答案只由 notes.is_sensitive 决定（标注即占位），与秘密值无关。A/B 的模型分拣是两次独立调用，
// 标注状态可能不一致（同一条在 A 标敏、B 未标）——这类差异是标注抖动而非秘密值 bit，单独归类为 annot_div。
async function sensState(acct) {
  const out = {};
  for (const [qid, id] of Object.entries(acct.notes)) {
    if (!id) continue;
    const r = await req(`/api/notes/${id}`, { token: acct.token });
    out[qid] = r.json?.note?.is_sensitive === true;
  }
  return out;
}
const sensA = await sensState(st.A);
const sensB = await sensState(st.B);
const annotDiv = new Set(Object.keys(sensA).filter((k) => sensA[k] !== sensB[k]));
console.log(`annotation: A sensitive=${Object.values(sensA).filter(Boolean).length} B sensitive=${Object.values(sensB).filter(Boolean).length} divergent=${[...annotDiv].join(",") || "-"}`);

const rows = existsSync(RES) ? JSON.parse(readFileSync(RES, "utf8")) : {};
const nz = (s) => norm(String(s ?? "").replace(/\[\d+\]/g, ""));
async function one(acct, q, secret) {
  const r = await ask(acct.token, q, { tier: "direct" });
  const j = r.json ?? {};
  const ans = j.answer ?? "";
  await sleep(4200);
  return { status: r.status, answer: ans, norm: nz(ans), refs: (j.notes ?? j.references ?? []).length, trust_tier: j.trust_tier ?? null, survive: nz(ans).includes(nz(secret)) };
}
let same = 0, diff = 0, survive = 0;
const diffKeys = [];
for (const q of Q) {
  for (const side of ["T", "F"]) {
    const key = `${q.id}/${side}`;
    const question = (side === "T" ? q.askT : q.askF).replaceAll("{S}", q.subject);
    if (!rows[key]) {
      rows[key] = { q: question, A: await one(st.A, question, q.secret), B: await one(st.B, question, st.alt[q.id]) };
      writeFileSync(RES, JSON.stringify(rows, null, 1));
    }
    const R = rows[key];
    const eq = R.A.norm === R.B.norm && R.A.refs === R.B.refs;
    if (eq) same++; else { diff++; diffKeys.push(key); }
    if (R.A.survive || R.B.survive) survive++;
    console.log(`${key} ${eq ? "SAME" : "DIFF"} refs=${R.A.refs}/${R.B.refs}${R.A.survive || R.B.survive ? " SURVIVE" : ""}`);
    if (!eq) console.log(`   A: ${JSON.stringify(R.A.answer).slice(0, 160)}\n   B: ${JSON.stringify(R.B.answer).slice(0, 160)}`);
  }
}
console.log(`== oracle-pair: questions=${Q.length * 2} same=${same} diff(bits_upper)=${diff} survive=${survive}`);

// 归因复测：把标注不一致的条目在两侧都显式标敏（手动标注对模型复判粘性），只重问 DIFF 题；
// 对齐后若变 SAME ⇒ 差异来自标注抖动（A/B 两次独立模型分拣），不是秘密值 bit。
if (diffKeys.length > 0 && annotDiv.size > 0) {
  for (const qid of annotDiv) {
    for (const acct of [st.A, st.B]) {
      const cur = acct === st.A ? sensA[qid] : sensB[qid];
      if (!cur) await req(`/api/notes/${acct.notes[qid]}`, { method: "PATCH", token: acct.token, body: { is_sensitive: true } });
    }
  }
  await sleep(3000);
  let still = 0, survive2 = 0;
  for (const key of diffKeys) {
    const [qid] = key.split("/");
    const q = Q.find((x) => x.id === qid);
    const R = { q: rows[key].q, A: await one(st.A, rows[key].q, q.secret), B: await one(st.B, rows[key].q, st.alt[qid]) };
    rows[`${key}#aligned`] = R;
    writeFileSync(RES, JSON.stringify(rows, null, 1));
    const eq = R.A.norm === R.B.norm && R.A.refs === R.B.refs;
    if (!eq) still++;
    if (R.A.survive || R.B.survive) survive2++;
    console.log(`${key}#aligned ${eq ? "SAME" : "DIFF"} refs=${R.A.refs}/${R.B.refs}`);
    if (!eq) console.log(`   A: ${JSON.stringify(R.A.answer).slice(0, 160)}\n   B: ${JSON.stringify(R.B.answer).slice(0, 160)}`);
  }
  console.log(`== oracle-pair(aligned annotation): re-asked=${diffKeys.length} diff(bits_upper)=${still} survive=${survive2}`);
}
