#!/usr/bin/env bash
# R328 E（docs/decision-r328.md §5）：Worker 与 Pages 同一提交原子化同步部署 + 身份核验。
# audit-r327 §2：Pages 部署元数据曾标到不在 main 上的提交（Direct Upload 不带 --commit-hash 时取本机 HEAD）。
#
# R330 D（docs/decision-r330.md §4）：部署 SHA 必须 == origin/main HEAD（audit-r329 §2：生产曾部署到 #365 倒数第二个提交）。
#
# 步骤：
#   0. git fetch origin main；本机 HEAD != origin/main 即失败（无豁免开关）；
#   1. 工作区必须干净、HEAD 即要部署的提交（sha）；
#   2. Worker：wrangler versions upload --var BUILD_SHA:<sha> → versions deploy <id>@100%；
#   3. Pages：BUILD_SHA=<sha> npm run build → wrangler pages deploy dist --branch main --commit-hash <sha>；
#   4. 核验：GET <API>/health 的 build 与 <WEB>/ 的 <meta name="build"> 都等于 <sha>，任一不符 exit 1；
#   5. wrangler deployments list / pages deployment list 留证（stdout）。
#
# 用法：bash scripts/deploy-sync.sh [--skip-worker] [--skip-pages] [--allow-dirty]
# 环境：CLOUDFLARE_API_TOKEN（或已 wrangler login）；可覆盖 API_URL / WEB_URL / PAGES_PROJECT。
set -euo pipefail

cd "$(dirname "$0")/.."
API_URL="${API_URL:-https://suinian-api.zalize.com}"
WEB_URL="${WEB_URL:-https://suinian.zalize.com}"
PAGES_PROJECT="${PAGES_PROJECT:-suinian}"
SKIP_WORKER=0
SKIP_PAGES=0
ALLOW_DIRTY=0
for a in "$@"; do
  case "$a" in
    --skip-worker) SKIP_WORKER=1 ;;
    --skip-pages) SKIP_PAGES=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [[ $ALLOW_DIRTY -eq 0 && -n "$(git status --porcelain -- backend web docs)" ]]; then
  echo "deploy-sync: 工作区有未提交改动（backend/web/docs），先提交再部署（元数据必须对应真实提交）" >&2
  git status --short -- backend web docs >&2
  exit 1
fi
SHA="$(git rev-parse HEAD)"
SHORT="${SHA:0:7}"
git fetch --quiet origin main
MAIN_SHA="$(git rev-parse origin/main)"
if [[ "$SHA" != "$MAIN_SHA" ]]; then
  echo "deploy-sync: HEAD ($SHA) != origin/main ($MAIN_SHA)，生产只部署已合并的 main HEAD——先合并 PR 并 checkout main && git pull" >&2
  exit 1
fi
echo "== deploy-sync: HEAD=$SHA (origin/main=$MAIN_SHA) =="

if [[ $SKIP_WORKER -eq 0 ]]; then
  echo "== Worker: versions upload =="
  UPLOAD_OUT="$(cd backend && npx wrangler versions upload --var "BUILD_SHA:$SHA" --tag "$SHORT" --message "deploy-sync $SHA" 2>&1 | tee /dev/stderr)"
  VERSION_ID="$(printf '%s\n' "$UPLOAD_OUT" | sed -n 's/.*Worker Version ID:[[:space:]]*\([0-9a-f-]\{36\}\).*/\1/p' | head -n1)"
  if [[ -z "$VERSION_ID" ]]; then
    echo "deploy-sync: 未从 versions upload 输出解析到 Version ID" >&2
    exit 1
  fi
  echo "== Worker: versions deploy $VERSION_ID@100% =="
  (cd backend && npx wrangler versions deploy "$VERSION_ID@100%" -y)
fi

if [[ $SKIP_PAGES -eq 0 ]]; then
  echo "== Pages: build (BUILD_SHA=$SHA) =="
  (cd web && BUILD_SHA="$SHA" npm run build)
  echo "== Pages: deploy =="
  (cd web && npx wrangler pages deploy dist --project-name "$PAGES_PROJECT" --branch main --commit-hash "$SHA" --commit-dirty=false)
fi

echo "== verify build identity =="
ok=1
for i in 1 2 3 4 5 6; do
  API_BUILD="$(curl -fsS "$API_URL/health" | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')"
  WEB_BUILD="$(curl -fsS -H 'Cache-Control: no-cache' "$WEB_URL/?deploy-sync=$i" | sed -n 's/.*<meta name="build" content="\([0-9a-f]*\)".*/\1/p')"
  echo "  attempt $i: api.build=${API_BUILD:-<none>} web.build=${WEB_BUILD:-<none>}"
  if [[ ( $SKIP_WORKER -eq 1 || "$API_BUILD" == "$SHA" ) && ( $SKIP_PAGES -eq 1 || "$WEB_BUILD" == "$SHA" ) ]]; then
    ok=0
    break
  fi
  sleep 10
done
if [[ $ok -ne 0 ]]; then
  echo "deploy-sync: Worker / Pages 构建身份与 HEAD 不一致（api=$API_BUILD web=$WEB_BUILD head=$SHA）" >&2
  exit 1
fi
echo "deploy-sync: Worker 与 Pages 同为 $SHA"

echo "== evidence: wrangler deployments list =="
(cd backend && npx wrangler deployments list 2>&1 | tail -n 9)
echo "== evidence: wrangler pages deployment list =="
(cd web && npx wrangler pages deployment list --project-name "$PAGES_PROJECT" 2>&1 | grep -m 2 'pages.dev' | sed 's/  */ /g')
