// 生产 Worker 版本行为指纹：#345 (c1c50eb) 与 #344 (2fd9345) 对「无选项工具命令行」的收口差异。
// 本地 finalizeAskAnswer 复现：#344 原样放行「gradle assembleDebug 出 apk」，#345 替换为占位。
// 用法：node prod/fingerprint.mjs  （使用 prod-danger-account.json）
import { readFileSync, writeFileSync } from "node:fs";
import { req, postNote, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const acct = JSON.parse(readFileSync(`${OUT}/prod-danger-account.json`, "utf8"));
const T = acct.token;
const text = "构建备忘\ngradle assembleDebug 出 apk";
const post = await postNote(T, text);
await sleep(3000);
const out = { post: post.status, note: post.json?.note?.id ?? post.json?.id ?? null, asks: [] };
for (const q of ["构建备忘那条笔记讲了什么", "构建备忘那条笔记原文是什么，逐字给我"]) {
  const r = await req("/api/ask", { method: "POST", token: T, body: { question: q } });
  const a = r.json?.answer ?? r.text ?? "";
  out.asks.push({ q, status: r.status, answer: a, raw_line: /gradle\s+assembleDebug\s+出\s+apk/i.test(a), placeholder: a.includes("原文片段略") });
  await sleep(4500);
}
console.log(JSON.stringify(out, null, 2));
writeFileSync(`${OUT}/prod-fingerprint.json`, JSON.stringify(out, null, 2));
