#!/bin/bash
# 无 token 残留 QA 账号的 D1 级联清除（评测脚本中途失败、未走到自注销时使用）。
# 逐条复刻 src/account.ts deleteUserData 的语句顺序（note 子表 → user 子表 →
# auth_rate_limits → users），范围只限 name LIKE '[QA-R320]%' 且 id <> 'u_boss'。
# 附件 / R2：先列出并要求为 0（本脚本不碰 R2；有附件时用产品注销路径）。
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/out/d1-purge.txt"
cd "$(dirname "$0")/../../.."
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_GLOBAL_API_TOKEN:?}"
q() { npx wrangler d1 execute suinian --remote --json --command "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j[0].results), "changes=" + (j[0].meta && j[0].meta.changes))})'; }
QA="SELECT id FROM users WHERE name LIKE '[QA-R320]%' ESCAPE '\\' AND id <> 'u_boss'"
{
echo "# D1 purge $(date -u +%FT%TZ)"
echo "## targets"
q "SELECT id, name FROM users WHERE name LIKE '[QA-R320]%' ESCAPE '\\' AND id <> 'u_boss'"
echo "## attachments of targets (must be 0)"
ATT=$(q "SELECT COUNT(*) AS n FROM attachments WHERE note_id IN (SELECT id FROM notes WHERE user_id IN ($QA))")
echo "$ATT"
case "$ATT" in *'"n":0'*) ;; *) echo "attachments present: use product DELETE /api/auth/me"; exit 2;; esac
for t in attachments note_embeddings; do
  echo "## delete $t"; q "DELETE FROM $t WHERE note_id IN (SELECT id FROM notes WHERE user_id IN ($QA))"
done
for t in daily_reviews notes threads weekly_reports entities edges user_preferences push_subscriptions push_daily_log thread_jobs thread_backfill wechat_mp_bindings wechat_mp_bind_codes wecom_kf_bindings api_tokens; do
  echo "## delete $t"; q "DELETE FROM $t WHERE user_id IN ($QA)"
done
echo "## delete auth_rate_limits by user id"
q "DELETE FROM auth_rate_limits WHERE EXISTS (SELECT 1 FROM users u WHERE u.name LIKE '[QA-R320]%' ESCAPE '\\' AND u.id <> 'u_boss' AND auth_rate_limits.key LIKE '%:' || REPLACE(REPLACE(REPLACE(u.id,'\\','\\\\'),'%','\\%'),'_','\\_') ESCAPE '\\')"
echo "## delete auth_rate_limits by acct name"
q "DELETE FROM auth_rate_limits WHERE EXISTS (SELECT 1 FROM users u WHERE u.name LIKE '[QA-R320]%' ESCAPE '\\' AND u.id <> 'u_boss' AND auth_rate_limits.key LIKE '%:acct:' || REPLACE(REPLACE(REPLACE(u.name,'\\','\\\\'),'%','\\%'),'_','\\_') ESCAPE '\\')"
echo "## delete users"
q "DELETE FROM users WHERE name LIKE '[QA-R320]%' ESCAPE '\\' AND id <> 'u_boss'"
echo "## users after"
q "SELECT id, name FROM users ORDER BY created_at"
} | tee "$OUT"
