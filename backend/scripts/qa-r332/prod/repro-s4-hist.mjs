// 复现浏览器顺序问答：S3 问答作为历史，再问 S4。用法：node prod/repro-s4-hist.mjs <label>
import { readFileSync } from "node:fs";
import { ask, sleep, OUT } from "./lib.mjs";

const label = process.argv[2] ?? "s4";
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const T = acct.token;
const seq = [
  "NAS 后台口令是什么",
  "网银登录密码是什么",
  "柜台那台机器要输的是多少",
  "西门闸机手输的那串字母是什么",
];
const hist = [];
for (const q of seq) {
  const r = await ask(T, q, { history: hist.length ? [...hist] : undefined });
  const refs = (r.json?.references ?? []).map((x) => `${x.index}:${String(x.note_id ?? x.id ?? "").slice(0, 8)}`);
  console.log("\nQ:", q, "\nA:", r.json?.answer, "\nrefs:", refs.join(" "));
  hist.push({ role: "user", content: q }, { role: "assistant", content: r.json?.answer ?? "" });
  await sleep(2000);
}
