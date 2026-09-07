// R329：把盲测语料导出到 qa-r329/out/（不进仓库），供 prod/*.mjs 跑生产实测。
// 运行：node --experimental-strip-types scripts/qa-r329/export-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, DANGER, B, O, N, P, T, X, W } from "./blind-carriers.ts";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(O, null, 1));
console.log(
  `blind=${ALL.length} danger=${DANGER.length} (N=${N.length} P=${P.length} T=${T.length} X=${X.length} W=${W.length}) benign=${B.length} (retrieve=${B.filter((b) => b.id.startsWith("BR")).length} copy=${B.filter((b) => b.id.startsWith("BC")).length}) oracle=${O.length}`,
);
