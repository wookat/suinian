// P1-2 生产复测补充：写入新笔记并等待 triage 完成后，同问必须给出含新笔记的新答案（不命中旧缓存）。
// 用法：node prod/cache2.mjs（自行注册 [QA-R308] 账号、测完注销）
import { writeFileSync } from "node:fs";
import { req, register, postNote, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const acct = await register(`[QA-R308]cache2-${Date.now().toString(36)}`);
const T = acct.token;
for (const n of ["买书 《SICP》 花了 128 元", "午饭 花了 38 元", "打车 花了 52 元"]) await postNote(T, n);
await sleep(25000);

async function ask(question) {
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const r = await req("/api/ask", { method: "POST", token: T, body: { question } });
    if (r.status === 429) {
      await sleep(20000);
      continue;
    }
    return { status: r.status, ms: Date.now() - t0, cache: r.headers.get("server-timing") ?? "", answer: r.json?.answer ?? r.text.slice(0, 200) };
  }
  return { status: 429, ms: 0, cache: "", answer: "" };
}
const hit = (r) => /anscache;desc=hit/.test(r.cache);
const Q = "我一共花了多少钱？分别是哪几笔？";
const rows = {};
rows.a1 = await ask(Q);
rows.a2 = await ask(Q); // 同键二次：应命中
await postNote(T, "买书 《DDIA》 花了 150 元");
rows.b0 = await ask(Q); // 写入后立刻：不得命中
await sleep(25000); // 等 triage 完成（金额入账）
rows.b1 = await ask(Q); // triage 后：不得命中旧答案，且应含 DDIA/150
rows.b2 = await ask(Q); // 同键二次：可命中（新键）
const summary = {
  a1: { hit: hit(rows.a1), head: rows.a1.answer.slice(0, 60) },
  a2: { hit: hit(rows.a2), same: rows.a2.answer === rows.a1.answer },
  b0: { hit: hit(rows.b0), sameAsA1: rows.b0.answer === rows.a1.answer },
  b1: { hit: hit(rows.b1), sameAsA1: rows.b1.answer === rows.a1.answer, mentionsDDIA: /DDIA|150/.test(rows.b1.answer), head: rows.b1.answer.slice(0, 60) },
  b2: { hit: hit(rows.b2), same: rows.b2.answer === rows.b1.answer },
  pass: !hit(rows.b0) && !hit(rows.b1) && rows.b1.answer !== rows.a1.answer && /DDIA|150/.test(rows.b1.answer),
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/prod-cache2.json`, JSON.stringify({ summary, rows }, null, 1));
const del = await req("/api/auth/me", { method: "DELETE", token: T });
const after = await req("/api/auth/me", { token: T });
console.log("account deleted", del.status, "old token ->", after.status);
