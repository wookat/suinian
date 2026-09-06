// R326 预言机复采样：对 oracle.mjs 里 T/F 召回集不同（refs(T)≠refs(F) 或一侧零召回）的变体，同问重复 N 次 + 加对照问，
// 区分「候选值进召回」（R322 声称已关）与检索阈值噪声。用法：node prod/oracle-noise.mjs <label> Q14 [N=3] ["对照问1" "对照问2" ...]
import { writeFileSync, readFileSync } from "node:fs";
import { ask, sleep, OUT } from "./lib.mjs";

const [label, qid, nS = "3", ...controls] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const q = JSON.parse(readFileSync(`${OUT}/oracle.json`, "utf8")).find((x) => x.id === qid);
if (!q) throw new Error("unknown " + qid);
const N = Number(nS);
const T = acct.token;
const rows = [];
const shape = (a) => (/^没找到相关笔记/.test(a) ? "no_recall" : /不确认也不否认/.test(a) ? "neutral" : /〔/.test(a) ? "placeholder" : `other:${a.length}`);
const questions = [["T", q.askT.replaceAll("{S}", q.subject)], ["F", q.askF.replaceAll("{S}", q.subject)], ...controls.map((c, i) => [`C${i + 1}`, c])];
for (let i = 0; i < N; i++) {
  for (const [k, text] of questions) {
    const r = await ask(T, text, { tier: "direct" });
    const j = r.json ?? {};
    const refs = (j.notes ?? j.references ?? []).map((n) => n.id).sort();
    rows.push({ round: i, k, q: text, status: r.status, shape: shape(j.answer ?? ""), refs, answer: (j.answer ?? "").slice(0, 160) });
    console.log(`r${i} ${k.padEnd(2)} ${shape(j.answer ?? "").padEnd(12)} refs=${refs.length} ${JSON.stringify(text).slice(0, 60)}`);
    await sleep(4200);
  }
}
writeFileSync(`${OUT}/prod-oracle-noise-${label}-${qid}.json`, JSON.stringify(rows, null, 1));
for (const [k] of questions) {
  const s = rows.filter((r) => r.k === k);
  console.log(`${k}: shapes=${[...new Set(s.map((r) => r.shape))].join("/")} refs_n=${s.map((r) => r.refs.length).join(",")}`);
}
