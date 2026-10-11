#!/usr/bin/env bash
# prod-smoke.sh — suinian 生产只读冒烟（不动数据，循环轮开轮就跑一遍）
# 覆盖面固化自 R425–R428 手工回归项。用法：bash scripts/prod-smoke.sh
set -u
API="https://suinian-api.zalize.com"
WEB="https://suinian.zalize.com"
fail=0
step() { printf '%-46s' "$1"; }
ok()   { echo "OK $*"; }
bad()  { echo "FAIL $*"; fail=1; }

# 1) 三端版本一致：web meta build == api /health build
step "build 一致 (web vs api)"
wb=$(curl -fsS "$WEB/" 2>/dev/null | sed -n 's/.*meta name="build" content="\([a-f0-9]*\)".*/\1/p')
ab=$(curl -fsS "$API/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('build',''))" 2>/dev/null)
[ -n "$wb" ] && [ "$wb" = "$ab" ] && ok "$ab" || bad "web=$wb api=$ab"

# 2) API 健康 + AI 主链未降级
step "/health?probe=ai"
ai=$(curl -fsS "$API/health?probe=ai" 2>/dev/null)
echo "$ai" | grep -q '"ok":true' && echo "$ai" | grep -q '"degraded":false' && ok "primary 健康" || bad "$ai"

# 3) 鉴权门：未授权必须 401/403（服务活着且 fail-closed）
#    覆盖 R425–R428 手工回归过的端点面
for ep in /api/notes /api/ask /api/preferences /api/stats /api/tags \
          /api/threads /api/reports /api/todos/today /api/review/today \
          /api/notes/random /api/notes/trash /api/export /api/backup \
          /api/wechat/binding /api/bridge/heartbeat \
          /api/push/config /api/auth/me /api/admin/sw-error-stats; do
  step "未授权 $ep → 401/403"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$API$ep")
  { [ "$c" = 401 ] || [ "$c" = 403 ]; } && ok "" || bad "got $c"
done

# 4) 登录端点活着（空体 POST → 4xx 而非 404/5xx）
step "POST /api/auth/login 空体 → 4xx"
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/api/auth/login")
{ [ "$c" -ge 400 ] && [ "$c" -lt 500 ]; } && ok "$c" || bad "got $c"

# 5) 公开端点：注册策略（注册页依赖）
step "GET /api/auth/register-policy → 200"
c=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/auth/register-policy")
[ "$c" = 200 ] && ok "" || bad "got $c"

# 6) CORS 预检：web 源 OPTIONS 须回 allow-origin
step "CORS preflight (OPTIONS /api/notes)"
oc=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
      -H "Origin: $WEB" -H "Access-Control-Request-Method: GET" "$API/api/notes")
oa=$(curl -s -D- -o /dev/null -X OPTIONS \
      -H "Origin: $WEB" -H "Access-Control-Request-Method: GET" "$API/api/notes" \
      | grep -i "access-control-allow-origin" | grep -c "suinian.zalize.com")
[ "$oc" = 204 ] && [ "$oa" -ge 1 ] && ok "204 + allow-origin" || bad "code=$oc acao_lines=$oa"

# 7) 静态资产、PWA 图标与前端路由
for a in sw.js push-sw.js manifest.webmanifest robots.txt sitemap.xml \
         favicon.svg icon-192.png icon-512.png \
         login welcome demo; do
  step "GET /$a"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$WEB/$a")
  [ "$c" = 200 ] && ok "" || bad "got $c"
done

# 8) 安全响应头（spot-check + CSP 关键指令含 beacon 白名单）
step "安全响应头"
h=$(curl -fsSI "$WEB/" 2>/dev/null)
miss=""
echo "$h" | grep -qi "x-frame-options: DENY" || miss="$miss x-frame-options"
echo "$h" | grep -qi "referrer-policy: strict-origin-when-cross-origin" || miss="$miss referrer-policy"
echo "$h" | grep -qi "content-security-policy:.*default-src 'self'" || miss="$miss csp"
echo "$h" | grep -qi "script-src.*cloudflareinsights" || miss="$miss csp-beacon"
echo "$h" | grep -qi "connect-src.*cloudflareinsights" || miss="$miss csp-beacon-connect"
[ -z "$miss" ] && ok "全在位" || bad "缺:$miss"

# 9) sw.js 引用 push-sw（推送链依赖）
step "sw.js 引用 push-sw"
sw=$(curl -fsS "$WEB/sw.js" 2>/dev/null)
echo "$sw" | grep -q "push-sw" && ok "" || bad "sw.js 未引用 push-sw"

echo
if [ "$fail" = 0 ]; then echo "prod-smoke: ALL OK ($(date -u +%H:%M)Z, build ${ab:0:7})"; else echo "prod-smoke: FAILURES ↑"; exit 1; fi
