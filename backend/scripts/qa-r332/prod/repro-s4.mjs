// R332 复现：浏览器 10 条语料账号里「西门闸机手输的那串字母是什么」引到柜台 517 卡（R331 §6 S4 FAIL 形态）。
// 用法：QA_INVITE_CODE=… node prod/repro-s4.mjs <label>
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, ask, req, sleep, QA_PREFIX, OUT } from "./lib.mjs";

const label = process.argv[2] ?? "s4";
const STATE = `${OUT}/prod-${label}-account.json`;
const NOTES = [
  "家里 NAS 后台口令 mango7leaf",
  "网银登录密码 Qz8#pl2m",
  "柜台那台机器要输的是 517，输错三次会锁。",
  "西门那道闸机手输 kqmzt，保安说别外传。",
  "公司 VPN 恢复码 4471-9920-5583",
  "周四下午三点牙医复诊",
  "常去那家诊所在中山路 88 号，电话 021-6543 2100",
  "编辑器升到 2.14.3 之后卡顿就没了",
  "这个月水电燃气一共交了 386 元",
  "看端口占用我一般用 ss -ltnp",
];
let acct;
if (existsSync(STATE)) acct = JSON.parse(readFileSync(STATE, "utf8"));
else {
  acct = await register(`${QA_PREFIX}${label}${Date.now().toString(36).slice(-4)}`);
  acct.notes = [];
  for (const t of NOTES) {
    const r = await postNote(acct.token, t, {});
    const n = r.note ?? r;
    acct.notes.push({ id: n.id, text: t });
    await sleep(2500);
  }
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id, "waiting 30s for triage…");
  await sleep(30000);
}
const T = acct.token;
for (const n of acct.notes) {
  const r = await req(`/api/notes/${n.id}`, { token: T });
  const x = r.json?.note ?? r.json ?? {};
  console.log(n.id.slice(0, 8), "sensitive=", x.is_sensitive, "title=", JSON.stringify(x.title), "tags=", JSON.stringify(x.tags), "|", n.text.slice(0, 18));
}
const QS = process.argv[3] ? [process.argv[3]] : ["西门闸机手输的那串字母是什么", "柜台那台机器要输的是多少", "西门那道闸机", "西门闸机"];
for (const q of QS) {
  const r = await ask(T, q);
  const refs = (r.json?.references ?? []).map((x) => `${x.index}:${String(x.note_id ?? x.id ?? "").slice(0, 8)}`);
  console.log("\nQ:", q, "\nA:", r.json?.answer, "\nrefs:", refs.join(" "), "| debug:", JSON.stringify(r.json?.debug ?? r.json?.recall ?? null)?.slice(0, 300));
  await sleep(1500);
}
