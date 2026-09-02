// QA 账号注销（走产品自身注销级联）+ 残留清单输出。绝不触碰 u_boss。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { req, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const log = [];
const L = (...a) => { console.log(...a); log.push(a.join(" ")); };

async function delWithToken(label, token) {
  let me;
  for (let i = 0; i < 4; i++) {
    me = await req("/api/auth/me", { token });
    if (me.status < 500) break;
    await sleep(3000);
  }
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  if (me.status !== 200) { L(label, "me status", me.status, "- skip (token file kept)"); return false; }
  if (!String(name).startsWith("[QA-R308]")) { L(label, "REFUSE: not a QA account", JSON.stringify(name)); return false; }
  const cnt = await req("/api/notes?limit=100", { token });
  const del = await req("/api/auth/me", { method: "DELETE", token });
  const after = await req("/api/auth/me", { token });
  L(label, name, "notes≈", cnt.json?.notes?.length ?? "?", "delete", del.status, "old token after:", after.status);
  return del.status === 200 && after.status === 401;
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
// 注销确认成功（DELETE 200 + 旧 token 401）才删 token 文件；跳过/失败时保留以便重试，
// 否则随机密码账号会丢失凭证，只能走 D1 手工补救。
for (const f of ["prod-danger-account.json", "prod-benign-account.json"]) {
  const p = `${OUT}/${f}`;
  if (!existsSync(p)) continue;
  const a = JSON.parse(readFileSync(p, "utf8"));
  if (await delWithToken(f, a.token)) unlinkSync(p);
}
// 2) 其余脚本（regress/*、lh.mjs、mixed.mjs、cache.mjs、sse.mjs、testing agent 浏览器账号）均在各自流程末尾自行注销并校验旧 token 401。
writeFileSync(`${OUT}/prod-cleanup.log`, log.join("\n") + "\n");
