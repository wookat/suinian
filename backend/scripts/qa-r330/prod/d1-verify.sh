#!/bin/bash
# R330 D1 逐表权威核验（R322 同款）：每张表按列结构核验孤儿/QA 残留。只读；token 取自环境变量。
set -euo pipefail
OUT="$(cd "$(dirname "$0")/.." && pwd)/out/d1-verify.txt"
cd "$(dirname "$0")/../../.."
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_GLOBAL_API_TOKEN:?}"
q() { npx wrangler d1 execute suinian --remote --json --command "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(j[0].results))})'; }
{
echo "# D1 verify $(date -u +%FT%TZ)"
echo "## users"
q "SELECT id, name FROM users ORDER BY created_at"
echo "## users LIKE QA"
q "SELECT count(*) AS qa_users FROM users WHERE name LIKE '[QA-%' OR name LIKE 'qa-%' OR name LIKE '%QA-R%'"
TABLES=$(q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(r=>r.name).join(" ")))')
echo "## tables: $TABLES"
for t in $TABLES; do
  COLS=$(q "PRAGMA table_info($t)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(r=>r.name).join(",")))')
  TOTAL=$(q "SELECT count(*) AS n FROM $t" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')
  LINE="table=$t total=$TOTAL"
  if [[ ",$COLS," == *",user_id,"* ]]; then
    ORPH=$(q "SELECT count(*) AS n FROM $t WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')
    NONBOSS=$(q "SELECT count(*) AS n FROM $t WHERE user_id IS NOT NULL AND user_id <> 'u_boss'" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')
    LINE="$LINE user_id_orphans=$ORPH non_boss_rows=$NONBOSS"
  fi
  if [[ ",$COLS," == *",note_id,"* ]]; then
    ORPH=$(q "SELECT count(*) AS n FROM $t WHERE note_id IS NOT NULL AND note_id NOT IN (SELECT id FROM notes)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')
    LINE="$LINE note_id_orphans=$ORPH"
  fi
  if [[ "$t" == "auth_rate_limits" ]]; then
    QA=$(q "SELECT count(*) AS n FROM auth_rate_limits WHERE key LIKE '%QA-R%'" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')
    LINE="$LINE qa_keys=$QA"
    echo "$LINE"
    echo "  auth_rate_limits keys sample:"; q "SELECT key, count FROM auth_rate_limits ORDER BY key LIMIT 40"
    continue
  fi
  if [[ "$t" == "media_encrypt_failures" || "$t" == "guard_events" ]]; then
    echo "$LINE"; q "SELECT * FROM $t ORDER BY rowid DESC LIMIT 5"; continue
  fi
  echo "$LINE"
done
} | tee "$OUT"
