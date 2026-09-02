// 附件 R2 密文核验：上传明文文件 → 标敏感 → R2 权威读取对象（应为 SNE1 信封，不含明文）→ 注销 → R2 权威列举零残留
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { register, req, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const ACC = process.env.CF_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_GLOBAL_API_TOKEN;
if (!ACC || !TOKEN) throw new Error("need CF_ACCOUNT_ID + CLOUDFLARE_GLOBAL_API_TOKEN in env");
const log = [];
const L = (...a) => { console.log(...a); log.push(a.join(" ")); };

async function r2list(prefix) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/suinian-media/objects?per_page=1000&prefix=${encodeURIComponent(prefix)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  return j.result.map((o) => o.key);
}
function r2get(key) {
  const f = `${OUT}/r2-object.bin`;
  execFileSync("npx", ["wrangler", "r2", "object", "get", `suinian-media/${key}`, "--remote", "--file", f], { cwd: new URL("../../..", import.meta.url).pathname, env: { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN }, stdio: "pipe" });
  return f;
}

const a = await register(`[QA-R305]att${Math.random().toString(36).slice(2, 6)}`);
if (!a?.token) throw new Error("register failed");
L("registered", a.name, a.userId ?? "");
const marker = `R305-ATTACH-PLAINTEXT-${Math.random().toString(36).slice(2, 10)}`;
const bytes = Buffer.from(`银行卡密码备忘 ${marker}\n卡号 6222 0000 0000 0000 密码 123456\n`);
const up = await req("/api/ingest/media", { method: "POST", token: a.token, body: { type: "file", data_base64: bytes.toString("base64"), mime: "text/plain", file_name: "密码本.txt" } });
L("upload", up.status, JSON.stringify(up.json?.note ? { id: up.json.note.id, is_sensitive: up.json.note.is_sensitive, content: String(up.json.note.content).slice(0, 60) } : up.json).slice(0, 300));
const noteId = up.json?.note?.id;
await sleep(6000);
let me = await req("/api/auth/me", { token: a.token });
const userId = me.json?.id ?? me.json?.user?.id ?? me.json?.user_id;
L("userId", userId);
let keys = await r2list(`media/${userId}/`);
L("r2 objects after upload:", keys.length, keys.join(","));
let det = await req(`/api/notes/${noteId}`, { token: a.token });
L("note after triage is_sensitive=", det.json?.note?.is_sensitive ?? det.json?.is_sensitive, "attachments=", JSON.stringify(det.json?.note?.attachments ?? det.json?.attachments));
// 明文态检查
if (keys[0]) {
  const f = r2get(keys[0]);
  const buf = (await import("node:fs")).readFileSync(f);
  L("R2 object (pre-sensitive) head:", JSON.stringify(buf.subarray(0, 4).toString("latin1")), "containsPlain=", buf.includes(marker));
}
// 标敏感 → 应加密
const p = await req(`/api/notes/${noteId}`, { method: "PATCH", token: a.token, body: { is_sensitive: true } });
L("patch sensitive", p.status);
await sleep(4000);
keys = await r2list(`media/${userId}/`);
for (const k of keys) {
  const f = r2get(k);
  const buf = (await import("node:fs")).readFileSync(f);
  L("R2 object (sensitive) key=", k, "head=", JSON.stringify(buf.subarray(0, 4).toString("latin1")), "containsPlain=", buf.includes(marker), "size=", buf.length);
}
// 备份/导出中是否露明文
const bk = await req("/api/backup", { token: a.token, raw: true });
L("backup status", bk.status, "containsPlain=", bk.text ? bk.text.includes(marker) : "n/a");
// 注销
const del = await req("/api/auth/me", { method: "DELETE", token: a.token });
L("delete account", del.status);
await sleep(3000);
keys = await r2list(`media/${userId}/`);
L("r2 objects after delete:", keys.length);
const all = await r2list("");
L("r2 bucket total objects:", all.length);
writeFileSync(`${OUT}/prod-attach.log`, log.join("\n") + "\n");
writeFileSync(`${OUT}/prod-attach-user.txt`, String(userId) + "\n");
