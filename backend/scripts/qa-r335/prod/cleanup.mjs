// R335 · 注销全部 [QA-R335] 账号（DELETE /api/auth/me），确认旧 token 401，然后从 accounts.json 抹掉 token。
import { req, load, J } from "./lib.mjs";

const accts = load("accounts");
if (!accts) throw new Error("no accounts.json");
const res = { cleaned_at: new Date().toISOString(), accounts: {} };
for (const k of ["atk", "ben", "fold", "ctl"]) {
  const a = accts[k];
  if (!a?.token) { res.accounts[k] = { skipped: true }; continue; }
  const d = await req("/api/auth/me", { method: "DELETE", token: a.token });
  const after = await req("/api/auth/me", { token: a.token });
  res.accounts[k] = { name: a.name, user_id: a.user_id, notes: Object.keys(a.notes ?? {}).length, delete_status: d.status, after_status: after.status };
  console.log(k, a.name, "delete", d.status, "after", after.status);
  a.token = null;
  a.deleted_at = new Date().toISOString();
}
J("accounts", accts);
J("cleanup", res);
