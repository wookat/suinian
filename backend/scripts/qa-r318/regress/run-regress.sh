#!/bin/bash
# R318 生产回归（R317 副本）（既有 eval 脚本的审查方副本：只改 QA 前缀 [QA-R306]→[QA-R318] 与相对 import 路径，逻辑不动；
# 口令运行时随机、脚本内自行注销）。用法：bash scripts/qa-r318/regress/run-regress.sh [名称...]
O="$(cd "$(dirname "$0")/.." && pwd)/out"
R="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$0")/../../.."
export SUINIAN_API_BASE=https://suinian-api.zalize.com
# beta 邀请码：从本机 600 权限文件读入环境（不回显）
[ -z "${QA_INVITE_CODE:-}" ] && [ -r "$HOME/.suinian-r318-invite" ] && export QA_INVITE_CODE="$(tr -d "\n" < "$HOME/.suinian-r318-invite")"
# tsx：优先本机已有（npx 缓存或全局），否则退回 npx tsx
TSX="${TSX:-$(command -v tsx 2>/dev/null || ls -d ~/.npm/_npx/*/node_modules/.bin/tsx 2>/dev/null | head -1)}"
[ -n "$TSX" ] && [ -x "$TSX" ] || TSX="npx tsx"
run() { name=$1; shift; echo "=== $name start $(date -u +%T)"; "$@" > "$O/$name.log" 2>&1; echo "=== $name exit $? $(date -u +%T)"; }
sel=("$@")
sel_has() { [ ${#sel[@]} -eq 0 ] && return 0; for w in "${sel[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
sel_has faithful30   && run faithful30 $TSX "$R/qa-r278-faithful.ts" --out="$O/faithful30.json"
sel_has lifecycle    && run lifecycle $TSX "$R/qa-r304-lifecycle.ts"
sel_has finance36    && run finance36 $TSX "$R/qa-r304-finance.ts"
sel_has injection    && run injection $TSX "$R/injection-eval.ts" --out="$O/injection.json"
sel_has retrieval    && run retrieval $TSX "$R/retrieval-eval.ts" --out="$O/retrieval.json"
sel_has askeval      && run askeval $TSX "$R/ask-eval.ts"
sel_has faithful30-b && run faithful30-b $TSX "$R/qa-r278-faithful.ts" --out="$O/faithful30-b.json"
sel_has askeval-b    && run askeval-b $TSX "$R/ask-eval.ts"
