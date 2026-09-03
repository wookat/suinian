// R312 QA 账号注销（产品注销级联 DELETE /api/auth/me）+ 旧 token 401 校验。
// 只接受名字以 [QA-R312] 开头的账号；其他一律拒绝。绝不触碰 u_boss。
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
  if (!String(name).startsWith(QA_PREFIX)) { L(label, "REFUSE: not a QA-R312 account", JSON.stringify(name)); return false; }
  if (uid === "u_boss") { L(label, "REFUSE: u_boss"); return false; }
  const cnt = await req("/api/notes?limit=100", { token });
  let del = await req("/api/auth/me", { method: "DELETE", token });
  if (del.status !== 200) del = await req("/api/auth/me", { method: "DELETE", token });
  const after = await req("/api/auth/me", { token });
  L(label, name, uid, "notes≈", cnt.json?.notes?.length ?? "?", "delete", del.status, "old token after:", after.status);
  return after.status === 401;
}

const FILES = readdirSync(OUT).filter((f) => /^prod-.*-account\.json$/.test(f));
const done = [];
for (const f of FILES) {
  const a = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  if (await delWithToken(f, a.token)) done.push(f);
  log.push(`user_id ${a.user_id} name ${a.name}`);
}
writeFileSync(`${OUT}/prod-cleanup.log`, log.join("\n") + "\n");
for (const f of done) if (existsSync(`${OUT}/${f}`)) unlinkSync(`${OUT}/${f}`);
