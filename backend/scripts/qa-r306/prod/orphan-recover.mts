// 孤儿 QA 账号（口令/恢复码均已不可得）注销：为 [QA-R306] 前缀账号写入新恢复码哈希（D1，按 id+前缀双限定），
// 再走产品 /api/auth/recover → DELETE /api/auth/me 级联注销。绝不触碰 u_boss。恢复码/口令仅在内存。
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hashPassword, generateRecoveryCode, normalizeRecoveryCode } from "../../../src/auth";
const API = "https://suinian-api.zalize.com";
const [id, name] = process.argv.slice(2);
if (!id || !name || !name.startsWith("[QA-R306]") || id === "u_boss") throw new Error("usage: orphan-recover <id> <[QA-R306]name>");
const code = generateRecoveryCode();
const rh = await hashPassword(normalizeRecoveryCode(code)!);
const sql = `UPDATE users SET recovery_hash = '${rh.replace(/'/g, "''")}' WHERE id = '${id}' AND name = '${name.replace(/'/g, "''")}' AND name LIKE '[QA-R306]%' AND id <> 'u_boss'`;
const out = execFileSync("npx", ["wrangler", "d1", "execute", "suinian", "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
console.log("d1 changes:", JSON.parse(out)[0]?.meta?.changes);
const newPw = randomBytes(18).toString("base64url");
const rec = await fetch(`${API}/api/auth/recover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, recovery_code: code, new_password: newPw }) });
const rj = (await rec.json()) as { api_token?: string };
console.log("recover status", rec.status);
if (!rj.api_token) process.exit(1);
const del = await fetch(`${API}/api/auth/me`, { method: "DELETE", headers: { authorization: `Bearer ${rj.api_token}` } });
console.log("delete status", del.status);
const after = await fetch(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${rj.api_token}` } });
console.log("token after", after.status);
