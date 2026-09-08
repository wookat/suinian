// 复现浏览器顺序问答（前几问作为历史逐轮带上）：node prod/repro-seq.mjs <label> [mark=S3,S4] 问句1 问句2 …
// 打印每问 answer / refs 以及 done 面与流式 delta 面是否一致。
import { readFileSync } from "node:fs";
import { askStream, req, sleep, OUT } from "./lib.mjs";

const [label, ...rest] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const T = acct.token;
const short = (id) => String(id ?? "").slice(0, 8);
let qs = rest;
if (rest[0]?.startsWith("mark=")) {
  qs = rest.slice(1);
  for (const i of rest[0].slice(5).split(",").map((s) => Number(s.replace(/^S/i, "")) - 1)) {
    const id = acct.notes[i].id;
    const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { is_sensitive: true } });
    console.log(`mark ${short(id)} status=${p.status} sensitive_after=${(p.json?.note ?? p.json ?? {}).is_sensitive}`);
  }
  await sleep(3000);
}
const hist = [];
for (const q of qs) {
  const r = await askStream(T, q, { history: hist.length ? [...hist] : undefined });
  const j = r.done ?? {};
  const refs = (j.references ?? []).map((x) => `${x.index}:${short(x.note_id ?? x.id)}`);
  console.log(`\nQ: ${q}\nA(done): ${j.answer}\nrefs: ${refs.join(" ")} | deltas=${r.deltas} emitted==done: ${r.emitted === j.answer}`);
  if (r.emitted !== j.answer) console.log(`A(emitted): ${r.emitted}`);
  hist.push({ role: "user", content: q }, { role: "assistant", content: j.answer ?? "" });
  await sleep(2000);
}
