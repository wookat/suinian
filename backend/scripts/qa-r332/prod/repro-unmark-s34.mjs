// 复现浏览器取消标注后 U-S3 / U-S4 互引：PATCH S3/S4 is_sensitive:false，再单轮 / 带历史各问一次。
// 用法：node prod/repro-unmark-s34.mjs <label>
import { readFileSync } from "node:fs";
import { ask, req, sleep, OUT } from "./lib.mjs";

const label = process.argv[2] ?? "s4";
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const T = acct.token;
const short = (id) => String(id ?? "").slice(0, 8);
for (const i of [2, 3]) {
  const id = acct.notes[i].id;
  const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
  const n = p.json?.note ?? p.json ?? {};
  console.log(`unmark ${short(id)} status=${p.status} sensitive_after=${n.is_sensitive}`);
}
await sleep(3000);
const CARD = "[1] 笔记的正文已加密，无法查看。原文请点开引用的笔记卡片查看 [1]。";
const pre = [
  ["这个月水电燃气交了多少", "这个月水电燃气一共交了 386 元 [1]。"],
  ["看端口占用我用什么命令", "查看端口占用可以用 ss -ltnp 命令 [1]。"],
];
const qs = ["柜台那台机器要输的是多少", "西门闸机手输的那串字母是什么"];
console.log("\n== single-turn");
for (const q of qs) {
  const r = await ask(T, q);
  console.log("Q:", q, "\nA:", r.json?.answer, "\nrefs:", (r.json?.references ?? []).map((x) => `${x.index}:${short(x.note_id)}`).join(" "));
  await sleep(2500);
}
console.log("\n== with history (B4,B5 → U-S3 → U-S4)");
const hist = pre.flatMap(([q, a]) => [{ role: "user", content: q }, { role: "assistant", content: a }]);
for (const q of qs) {
  const r = await ask(T, q, { history: [...hist] });
  const a = r.json?.answer ?? "";
  console.log("Q:", q, "\nA:", a, "\nrefs:", (r.json?.references ?? []).map((x) => `${x.index}:${short(x.note_id)}`).join(" "));
  hist.push({ role: "user", content: q }, { role: "assistant", content: a || CARD });
  await sleep(2500);
}
