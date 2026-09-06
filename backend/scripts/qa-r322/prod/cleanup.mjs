// R313 QA 账号注销（产品注销级联 DELETE /api/auth/me）+ 旧 token 401 校验。
// 只接受名字以 [QA-R322] 开头的账号；其他一律拒绝。绝不触碰 u_boss。
// 账号文件：out/prod-*-account.json、out/lh-account.json（单账号对象）与 out/browser-accounts.json（数组，testing agent 的 4 个 Day1 账号），均只含 token/user_id/name，不含密码。
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { req, QA_PREFIX } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const log = [];
const L = (...a) => { console.log(...a); log.push(a.join(" ")); };

async function delWithToken(label, token) {
  const me = await req("/api/auth/me", { token });
  if (me.status !== 200) { L(label, "me status", me.status, "- skip"); return me.status === 401; }
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  const uid = me.json?.id ?? me.json?.user?.id ?? "";
  if (!String(name).startsWith(QA_PREFIX)) { L(label, "REFUSE: not a QA-R322 account", JSON.stringify(name)); return false; }
  if (uid === "u_boss") { L(label, "REFUSE: u_boss"); return false; }
  const cnt = await req("/api/notes?limit=100", { token });
  let del = await req("/api/auth/me", { method: "DELETE", token });
  if (del.status !== 200) del = await req("/api/auth/me", { method: "DELETE", token });
  const after = await req("/api/auth/me", { token });
  L(label, name, uid, "notes≈", cnt.json?.notes?.length ?? "?", "delete", del.status, "old token after:", after.status);
  return after.status === 401;
}

const FILES = readdirSync(OUT).filter((f) => /^(prod-.*-account|lh-account|browser-accounts)\.json$/.test(f));
const done = [];
for (const f of FILES) {
  const parsed = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  const accounts = Array.isArray(parsed) ? parsed : [parsed];
  let ok = true;
  for (const [i, a] of accounts.entries()) {
    if (!(await delWithToken(`${f}#${i}`, a.token))) ok = false;
    log.push(`user_id ${a.user_id ?? a.userId ?? "?"} name ${a.name ?? "?"}`);
  }
  if (ok) done.push(f);
}
writeFileSync(`${OUT}/prod-cleanup.log`, log.join("\n") + "\n", { flag: "a" });
for (const f of done) if (existsSync(`${OUT}/${f}`)) unlinkSync(`${OUT}/${f}`);
L("deleted", done.length, "/", FILES.length);
