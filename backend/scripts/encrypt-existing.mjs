// One-off migration: encrypt existing sensitive notes (is_sensitive=1, content_enc IS NULL)
// via the Cloudflare D1 REST API. Requires env:
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, SUINIAN_ENC_KEY
// Usage: node scripts/encrypt-existing.mjs [--dry-run]

import { webcrypto as crypto } from "node:crypto";

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, SUINIAN_ENC_KEY } = process.env;
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID || !SUINIAN_ENC_KEY) {
  console.error("missing env: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID / SUINIAN_ENC_KEY");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");
const PLACEHOLDER = "[加密内容]";

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
  return data.result[0]?.results ?? [];
}

async function importKey(keyB64) {
  const raw = Buffer.from(keyB64.trim(), "base64");
  if (raw.length !== 32) throw new Error("SUINIAN_ENC_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
}

async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `v1:${Buffer.from(iv).toString("base64")}:${Buffer.from(ct).toString("base64")}`;
}

const rows = await d1(
  "SELECT id, content FROM notes WHERE is_sensitive = 1 AND content_enc IS NULL"
);
console.log(`found ${rows.length} sensitive note(s) to encrypt${dryRun ? " (dry-run)" : ""}`);
if (rows.length === 0 || dryRun) process.exit(0);

const key = await importKey(SUINIAN_ENC_KEY);
for (const row of rows) {
  const enc = await encrypt(key, row.content);
  await d1(
    "UPDATE notes SET content_enc = ?, content = ?, updated_at = datetime('now') WHERE id = ? AND content_enc IS NULL",
    [enc, PLACEHOLDER, row.id]
  );
  console.log(`encrypted note ${row.id}`);
}
console.log("done");
