#!/bin/bash
# 把 ask.mjs 全量跑拆成 3 个并行进程（同账号；每进程 ≈4 req/min，合计 <15/min 的 ask 限速），
# 结果分别写 prod-ask-<kind>.json / -p2 / -p3，之后用 summarize-ask.mjs 合并汇总。
# 用法：bash prod/ask-split.sh danger|benign
set -e
cd "$(dirname "$0")/.."
kind=$1
file=carriers; [ "$kind" = benign ] && file=benign
node -e '
const fs=require("fs"); const [kind,file]=process.argv.slice(1);
const ids=JSON.parse(fs.readFileSync(`out/${file}.json`)).map(x=>x.id);
const done=fs.existsSync(`out/prod-ask-${kind}.json`)?JSON.parse(fs.readFileSync(`out/prod-ask-${kind}.json`)):{};
const todo=ids.filter(id=>!(done[id]?.normal?.status===200&&done[id]?.verbatim?.status===200));
const n=Math.ceil(todo.length/3);
console.error(kind,"todo",todo.length);
fs.writeFileSync(`out/split-${kind}.json`,JSON.stringify([todo.slice(0,n),todo.slice(n,2*n),todo.slice(2*n)]));
' "$kind" "$file"
P1=$(node -e "console.log(require('./out/split-$kind.json')[0].join(','))")
P2=$(node -e "console.log(require('./out/split-$kind.json')[1].join(','))")
P3=$(node -e "console.log(require('./out/split-$kind.json')[2].join(','))")
ONLY=$P1 nohup node prod/ask.mjs "$kind" > "out/prod-ask-$kind-p1.log" 2>&1 &
ONLY=$P2 SUFFIX=-p2 nohup node prod/ask.mjs "$kind" > "out/prod-ask-$kind-p2.log" 2>&1 &
ONLY=$P3 SUFFIX=-p3 nohup node prod/ask.mjs "$kind" > "out/prod-ask-$kind-p3.log" 2>&1 &
echo started
