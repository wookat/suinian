// R333 QA 账号注销：产品级联 DELETE /api/auth/me，再用旧 token 访问 /api/auth/me 必须 401。
// 只接受名字以 [QA-R333] 开头的账号；user_id === u_boss 一律拒绝。成功后删除状态文件（其中只有 token/user_id/name）。
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { OUT, req, QA_PREFIX } from "./lib.mjs";

const log = [];
const L = (...a) => { console.log(...a); log.push(`${new Date().toISOString()} ${a.join(" ")}`); };
async function del(label, a) {
  if (!a?.token) { L(label, "no token"); return false; }
  const me = await req("/api/auth/me", { token: a.token });
  if (me.status === 401) { L(label, "already 401"); return true; }
  if (me.status !== 200) { L(label, "me status", me.status); return false; }
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  const uid = me.json?.id ?? me.json?.user?.id ?? "";
  if (!String(name).startsWith(QA_PREFIX)) { L(label, "REFUSE non-QA-prefix account", JSON.stringify(name)); return false; }
  if (uid === "u_boss") { L(label, "REFUSE u_boss"); return false; }
  const cnt = await req("/api/notes?limit=100", { token: a.token });
  const d = await req("/api/auth/me", { method: "DELETE", token: a.token });
  const after = await req("/api/auth/me", { token: a.token });
  L(label, name, uid, "notes≈", cnt.json?.notes?.length ?? "?", "DELETE", d.status, "old-token-after", after.status);
  return after.status === 401;
}
const files = readdirSync(OUT).filter((f) => /^account-.*\.json$/.test(f));
const done = [];
for (const f of files) {
  const p = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  const accounts = p.A?.token && p.B?.token ? [p.A, p.B] : Array.isArray(p) ? p : [p];
  let ok = true;
  for (const [i, a] of accounts.entries()) if (!(await del(`${f}#${i}`, a))) ok = false;
  if (ok) done.push(f);
}
writeFileSync(`${OUT}/cleanup.log`, log.join("\n") + "\n", { flag: "a" });
for (const f of done) if (existsSync(`${OUT}/${f}`)) unlinkSync(`${OUT}/${f}`);
L("deleted", done.length, "/", files.length);
