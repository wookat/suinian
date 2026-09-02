#!/bin/bash
# R306 生产回归（QA 账号 [QA-R306] 前缀、口令运行时随机、脚本内自行注销）
O="$(cd "$(dirname "$0")" && pwd)/out"
cd "$(dirname "$0")/../.."
export SUINIAN_API_BASE=https://suinian-api.zalize.com
run() { name=$1; shift; echo "=== $name start $(date -u +%T)"; "$@" > "$O/$name.log" 2>&1; echo "=== $name exit $? $(date -u +%T)"; }
run faithful30 npx tsx scripts/qa-r278-faithful.ts
run lifecycle npx tsx scripts/qa-r304-lifecycle.ts
run finance36 npx tsx scripts/qa-r304-finance.ts
run injection npx tsx scripts/injection-eval.ts --out="$O/injection.json"
run retrieval npx tsx scripts/retrieval-eval.ts --out="$O/retrieval.json"
run askeval npx tsx scripts/ask-eval.ts
