#!/bin/bash
# R310 生产回归（既有 eval 脚本的审查方副本：只改 QA 前缀 [QA-R306]→[QA-R310] 与相对 import 路径，逻辑不动；
# 口令运行时随机、脚本内自行注销）。用法：bash scripts/qa-r310/regress/run-regress.sh [名称...]
O="$(cd "$(dirname "$0")/.." && pwd)/out"
R="$(cd "$(dirname "$0")" && pwd)"
cd "$(dirname "$0")/../../.."
export SUINIAN_API_BASE=https://suinian-api.zalize.com
run() { name=$1; shift; echo "=== $name start $(date -u +%T)"; "$@" > "$O/$name.log" 2>&1; echo "=== $name exit $? $(date -u +%T)"; }
sel=("$@")
sel_has() { [ ${#sel[@]} -eq 0 ] && return 0; for w in "${sel[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }
sel_has faithful30   && run faithful30   npx tsx "$R/qa-r278-faithful.ts" --out="$O/faithful30.json"
sel_has lifecycle    && run lifecycle    npx tsx "$R/qa-r304-lifecycle.ts"
sel_has finance36    && run finance36    npx tsx "$R/qa-r304-finance.ts"
sel_has injection    && run injection    npx tsx "$R/injection-eval.ts" --out="$O/injection.json"
sel_has retrieval    && run retrieval    npx tsx "$R/retrieval-eval.ts" --out="$O/retrieval.json"
sel_has askeval      && run askeval      npx tsx "$R/ask-eval.ts"
sel_has faithful30-b && run faithful30-b npx tsx "$R/qa-r278-faithful.ts" --out="$O/faithful30-b.json"
sel_has askeval-b    && run askeval-b    npx tsx "$R/ask-eval.ts"
