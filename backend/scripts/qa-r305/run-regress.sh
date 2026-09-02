#!/bin/bash
cd "$(dirname "$0")/../.."
export SUINIAN_API_BASE=https://suinian-api.zalize.com
O="$(cd "$(dirname "$0")" && pwd)/out"
run() { name=$1; shift; echo "=== $name start $(date -u +%T)"; "$@" > $O/$name.log 2>&1; echo "=== $name exit $? $(date -u +%T)"; }
run faithful30 npx tsx scripts/_r305/qa-r278-faithful.ts
run lifecycle npx tsx scripts/_r305/qa-r304-lifecycle.ts
run injection npx tsx scripts/_r305/injection-eval.ts --out=$O/injection.json
run retrieval npx tsx scripts/_r305/retrieval-eval.ts --out=$O/retrieval.json
run askeval npx tsx scripts/_r305/ask-eval.ts
