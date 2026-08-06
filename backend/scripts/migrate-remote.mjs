// Apply backend/migrations/*.sql to the remote D1 database via the Cloudflare
// REST API (wrangler v3's `d1 migrations apply --remote` is unreliable here).
// Tracks applied migrations in the same `d1_migrations` table wrangler uses,
// so already-applied migrations are skipped (idempotent).
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
// Optional env: D1_DATABASE_ID (defaults to database_id in wrangler.toml)
// Usage: node scripts/migrate-remote.mjs [--dry-run]

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID } = process.env;
let databaseId = process.env.D1_DATABASE_ID;
if (!databaseId) {
  const toml = readFileSync(join(backendDir, "wrangler.toml"), "utf8");
  databaseId = toml.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
}
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !databaseId) {
  console.error("missing env: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (and D1_DATABASE_ID or wrangler.toml database_id)");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
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

await d1(
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp)"
);
const applied = new Set((await d1("SELECT name FROM d1_migrations")).map((r) => r.name));

const files = readdirSync(join(backendDir, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
let ran = 0;
for (const f of files) {
  if (applied.has(f)) {
    console.log(`skip    ${f} (already applied)`);
    continue;
  }
  console.log(`${dryRun ? "would apply" : "apply"}  ${f}`);
  if (!dryRun) {
    const sql = readFileSync(join(backendDir, "migrations", f), "utf8");
    await d1(sql);
    await d1("INSERT INTO d1_migrations (name) VALUES (?)", [f]);
  }
  ran++;
}
console.log(dryRun ? `dry-run done: ${ran} pending` : `done: ${ran} applied, ${files.length - ran} skipped`);
