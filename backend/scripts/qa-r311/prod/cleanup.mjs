// R311 QA 账号注销（走产品自身注销级联 DELETE /api/auth/me）+ 旧 token 401 校验。
// 只接受名字以 [QA-R311] 开头的账号；其他一律拒绝。绝不触碰 u_boss。
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { req } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const log = [];
const L = (...a) => { console.log(...a); log.push(a.join(" ")); };

async function delWithToken(label, token) {
  const me = await req("/api/auth/me", { token });
  if (me.status !== 200) { L(label, "me status", me.status, "- skip"); return; }
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  const uid = me.json?.id ?? me.json?.user?.id ?? "";
  if (!String(name).startsWith("[QA-R311]")) { L(label, "REFUSE: not a QA-R311 account", JSON.stringify(name)); return; }
  if (uid === "u_boss") { L(label, "REFUSE: u_boss"); return; }
  const cnt = await req("/api/notes?limit=100", { token });
  const del = await req("/api/auth/me", { method: "DELETE", token });
  const after = await req("/api/auth/me", { token });
  L(label, name, uid, "notes≈", cnt.json?.notes?.length ?? "?", "delete", del.status, "old token after:", after.status);
}

const FILES = readdirSync(OUT).filter((f) => /^prod-.*-account\.json$/.test(f));
for (const f of FILES) {
  const a = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
  await delWithToken(f, a.token);
}
writeFileSync(`${OUT}/prod-cleanup.log`, log.join("\n") + "\n");
for (const f of FILES) if (existsSync(`${OUT}/${f}`)) unlinkSync(`${OUT}/${f}`);
