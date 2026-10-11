#!/usr/bin/env bash
# prod-smoke.sh — suinian 生产只读冒烟（不动数据，循环轮开轮就跑一遍）
# 用法：bash scripts/prod-smoke.sh
set -u
API="https://suinian-api.zalize.com"
WEB="https://suinian.zalize.com"
fail=0
step() { printf '%-44s' "$1"; }
ok()   { echo "OK $*"; }
bad()  { echo "FAIL $*"; fail=1; }

# 1) 三端版本一致：web meta /build.txt == api /health build
step "build 一致 (web vs api)"
wb=$(curl -fsS "$WEB/" 2>/dev/null | sed -n 's/.*meta name="build" content="\([a-f0-9]*\)".*/\1/p')
ab=$(curl -fsS "$API/health" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('build',''))" 2>/dev/null)
[ -n "$wb" ] && [ "$wb" = "$ab" ] && ok "$ab" || bad "web=$wb api=$ab"

# 2) API 健康 + AI 主链未降级
step "/health?probe=ai"
ai=$(curl -fsS "$API/health?probe=ai" 2>/dev/null)
echo "$ai" | grep -q '"ok":true' && echo "$ai" | grep -q '"degraded":false' && ok "primary 健康" || bad "$ai"

# 3) 未授权端点返回 401（服务活着且鉴权在位）
for ep in /api/notes /api/push/config /api/auth/me; do
  step "未授权 $ep → 401"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$API$ep")
  [ "$c" = 401 ] && ok "" || bad "got $c"
done

# 4) 静态资产与关键路由（/demo 为前端路由演示页，无后端接口）
for a in sw.js push-sw.js manifest.webmanifest robots.txt sitemap.xml login welcome demo; do
  step "GET /$a"
  c=$(curl -s -o /dev/null -w "%{http_code}" "$WEB/$a")
  [ "$c" = 200 ] && ok "" || bad "got $c"
done

# 5) 安全头在位（spot-check 三项 + CSP 含关键指令）
step "安全响应头"
h=$(curl -fsSI "$WEB/" 2>/dev/null)
miss=""
echo "$h" | grep -qi "x-frame-options: DENY" || miss="$miss x-frame-options"
echo "$h" | grep -qi "referrer-policy: strict-origin-when-cross-origin" || miss="$miss referrer-policy"
echo "$h" | grep -qi "content-security-policy:.*default-src 'self'" || miss="$miss csp"
echo "$h" | grep -qi "script-src.*cloudflareinsights" || miss="$miss csp-beacon"
echo "$h" | grep -qi "connect-src.*cloudflareinsights" || miss="$miss csp-beacon-connect"
[ -z "$miss" ] && ok "全在位" || bad "缺:$miss"

# 6) 服务 worker 文件内容与版本
step "sw.js 可解析且引用 push-sw"
sw=$(curl -fsS "$WEB/sw.js" 2>/dev/null)
echo "$sw" | grep -q "push-sw" && ok "" || bad "sw.js 未引用 push-sw"

echo
if [ "$fail" = 0 ]; then echo "prod-smoke: ALL OK ($(date -u +%H:%M)Z, build ${ab:0:7})"; else echo "prod-smoke: FAILURES ↑"; exit 1; fi
