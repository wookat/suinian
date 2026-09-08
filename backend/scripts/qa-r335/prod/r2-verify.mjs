// R335：R2 权威列举（沿用 R322/R333 只读脚本，输出到 qa-r335/out）
// R2 权威列举（Cloudflare API list，非缓存 GET）：全桶分页列举，按 user 前缀聚合，
// 断言非 u_boss 前缀零对象。只读。凭据取环境变量。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const OUT = process.env.QA_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(OUT, { recursive: true });
const ACC = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_GLOBAL_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
if (!ACC || !TOKEN)
  throw new Error(
    "need CF_ACCOUNT_ID + CLOUDFLARE_GLOBAL_API_TOKEN（账号 ID：cd backend && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_GLOBAL_API_TOKEN npx wrangler whoami）"
  );
const BUCKET = process.env.R2_BUCKET ?? "suinian-media";
let cursor = null;
const keys = [];
for (;;) {
  const u = new URL(`https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/${BUCKET}/objects`);
  u.searchParams.set("per_page", "1000");
  if (cursor) u.searchParams.set("cursor", cursor);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors));
  for (const o of j.result ?? []) keys.push({ key: o.key, size: o.size, uploaded: o.uploaded });
  cursor = j.result_info?.cursor;
  if (!cursor || (j.result ?? []).length === 0 || j.result_info?.is_truncated === false) break;
}
const byPrefix = {};
// 实际 key 形如 media/<user_id>/<note_id>/<file>（qa-attach.ts 实测）；兼容顶层直接 <user_id>/ 的旧布局
const userOf = (key) => {
  const seg = key.split("/");
  return seg[0].startsWith("u_") ? seg[0] : seg[1] ?? seg[0];
};
for (const k of keys) {
  const p = userOf(k.key);
  byPrefix[p] = (byPrefix[p] ?? 0) + 1;
}
const nonBoss = keys.filter((k) => userOf(k.key) !== "u_boss");
const summary = { checked_at: new Date().toISOString(), bucket: BUCKET, total: keys.length, byPrefix, non_boss_objects: nonBoss.length, non_boss_keys: nonBoss.map((k) => k.key) };
console.log(JSON.stringify(summary, null, 2));
writeFileSync(join(OUT, "r2-verify.json"), JSON.stringify({ ...summary, keys }, null, 1));
