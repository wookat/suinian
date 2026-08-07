#!/usr/bin/env bash
# 碎念一键自部署脚本：交互式创建 Cloudflare 资源并部署。
# 前置：Node.js >= 20；已 `npx wrangler login` 或设置 CLOUDFLARE_API_TOKEN
# （token 需要 Workers Scripts / D1 / R2 / Pages / Workers AI 的编辑权限）。
# 用法：在仓库根目录执行 bash scripts/setup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
W="npx wrangler"

prompt() { # prompt <var> <question> <default>
  local var=$1 q=$2 def=${3:-}
  read -r -p "$q${def:+ [$def]}: " val
  eval "$var=\"\${val:-$def}\""
}

echo "== 碎念自部署 =="
prompt WORKER_NAME "Worker 名称" "suinian-api"
prompt DB_NAME "D1 数据库名称" "suinian"
prompt BUCKET_NAME "R2 bucket 名称（存语音/图片/文件原件）" "suinian-media"
prompt PAGES_PROJECT "Pages 项目名称（Web 端）" "suinian"

cd "$ROOT/backend"
echo "-- 安装后端依赖"
npm install --no-fund --no-audit

echo "-- 创建 D1 数据库 $DB_NAME"
D1_OUT=$($W d1 create "$DB_NAME" 2>&1) || { echo "$D1_OUT"; echo "（已存在？继续）"; }
DB_ID=$(echo "$D1_OUT" | grep -o 'database_id = "[^"]*"' | cut -d'"' -f2 || true)
if [ -z "${DB_ID:-}" ]; then
  DB_ID=$($W d1 info "$DB_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
fi
echo "   database_id: $DB_ID"

echo "-- 创建 R2 bucket $BUCKET_NAME"
$W r2 bucket create "$BUCKET_NAME" 2>&1 | tail -1 || echo "（已存在？继续）"

echo "-- 生成 wrangler.toml（原文件备份为 wrangler.toml.bak）"
cp wrangler.toml wrangler.toml.bak
python3 - "$WORKER_NAME" "$DB_NAME" "$DB_ID" "$BUCKET_NAME" <<'EOF'
import re, sys
worker, db, dbid, bucket = sys.argv[1:5]
s = open("wrangler.toml").read()
s = re.sub(r'^name = ".*"', f'name = "{worker}"', s, count=1, flags=re.M)
s = re.sub(r'routes = \[\n.*?\n\]\n', '', s, flags=re.S)  # 官方实例的自定义域，自部署不需要
s = re.sub(r'database_name = ".*"', f'database_name = "{db}"', s)
s = re.sub(r'database_id = ".*"', f'database_id = "{dbid}"', s)
s = re.sub(r'bucket_name = ".*"', f'bucket_name = "{bucket}"', s)
open("wrangler.toml", "w").write(s)
EOF

echo "-- 执行 migrations"
$W d1 migrations apply "$DB_NAME" --remote

echo "-- 设置密钥"
read -r -p "DeepSeek API Key（留空则用 Workers AI，无需外部 key）: " DSK
if [ -n "$DSK" ]; then
  printf '%s' "$DSK" | $W secret put DEEPSEEK_API_KEY
else
  printf 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast' | $W secret put AI_MODEL
fi
echo "   生成敏感内容加密密钥 SUINIAN_ENC_KEY（请自行备份 wrangler 输出前的值）"
ENC_KEY=$(openssl rand -base64 32)
printf '%s' "$ENC_KEY" | $W secret put SUINIAN_ENC_KEY
echo "   SUINIAN_ENC_KEY 已设置——务必另行备份，丢失将无法解密存量敏感笔记"

echo "-- 部署 Worker"
DEPLOY_OUT=$($W deploy 2>&1); echo "$DEPLOY_OUT" | grep -E "workers.dev|Deployed" || echo "$DEPLOY_OUT"
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[^ ]*workers.dev' | head -1)

echo "-- 构建并部署 Web 端（Pages 项目 $PAGES_PROJECT）"
cd "$ROOT/web"
npm install --no-fund --no-audit
npm run build
$W pages project create "$PAGES_PROJECT" --production-branch main 2>/dev/null || true
PAGES_OUT=$($W pages deploy dist --project-name "$PAGES_PROJECT" --branch main 2>&1)
echo "$PAGES_OUT" | grep -oE 'https://[^ ]*pages.dev' | tail -1 || echo "$PAGES_OUT"
PAGES_URL="https://$PAGES_PROJECT.pages.dev"

echo "-- 允许 Web 端跨域访问 API（CORS_ALLOWED_ORIGINS）"
cd "$ROOT/backend"
python3 - "$PAGES_URL" <<'EOF'
import sys
s = open("wrangler.toml").read()
if "CORS_ALLOWED_ORIGINS" not in s:
    s = s.replace('[vars]', '[vars]\nCORS_ALLOWED_ORIGINS = "%s"' % sys.argv[1], 1)
    open("wrangler.toml", "w").write(s)
EOF
$W deploy >/dev/null 2>&1 || true

echo
echo "== 完成 =="
echo "API:  ${WORKER_URL:-（见上方 wrangler 输出）}"
echo "Web:  $PAGES_URL"
echo "下一步：打开 Web 端 → 引导里选「注册新账号」→ API 地址填 $WORKER_URL"
echo "验证：curl ${WORKER_URL:-<你的 worker 地址>}/health"
