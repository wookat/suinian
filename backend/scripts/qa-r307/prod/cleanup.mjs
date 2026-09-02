// QA 账号注销（走产品自身注销级联）+ 残留清单输出。绝不触碰 u_boss。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { req, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const log = [];
const L = (...a) => { console.log(...a); log.push(a.join(" ")); };

async function delWithToken(label, token) {
  const me = await req("/api/auth/me", { token });
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  if (me.status !== 200) { L(label, "me status", me.status, "- skip"); return; }
  if (!String(name).startsWith("[QA-R307]")) { L(label, "REFUSE: not a QA account", JSON.stringify(name)); return; }
  const cnt = await req("/api/notes?limit=100", { token });
  const del = await req("/api/auth/me", { method: "DELETE", token });
  const after = await req("/api/auth/me", { token });
  L(label, name, "notes≈", cnt.json?.notes?.length ?? "?", "delete", del.status, "old token after:", after.status);
}
async function login(name, password) {
  for (let i = 0; i < 5; i++) {
    const r = await req("/api/auth/login", { method: "POST", body: { name, password } });
    if (r.status === 200 && r.json?.api_token) return r.json.api_token;
    if (r.status === 429) { await sleep(65000); continue; }
    L("login failed", name, r.status); return null;
  }
  return null;
}

// 1) 危险/善意账号（token 文件）
for (const f of ["prod-danger-account.json", "prod-benign-account.json"]) {
  const p = `${OUT}/${f}`;
  if (!existsSync(p)) continue;
  const a = JSON.parse(readFileSync(p, "utf8"));
  await delWithToken(f, a.token);
}
// 2) 其余脚本（regress/*、lh.mjs、mixed.mjs、cache.mjs、sse.mjs、testing agent 浏览器账号）均在各自流程末尾自行注销并校验旧 token 401。
writeFileSync(`${OUT}/prod-cleanup.log`, log.join("\n") + "\n");
for (const f of [`${OUT}/prod-danger-account.json`, `${OUT}/prod-benign-account.json`]) if (existsSync(f)) unlinkSync(f);
