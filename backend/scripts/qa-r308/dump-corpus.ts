// 把 TS 语料导出为 out/carriers.json / out/benign.json 供 prod/*.mjs 使用。
// 用法（在 backend/ 目录）：npx tsx scripts/qa-r307/dump-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS } from "../qa-r307/carriers";
import { BENIGN } from "../qa-r307/benign";
const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/carriers.json`, JSON.stringify(CARRIERS, null, 1));
writeFileSync(`${OUT}/benign.json`, JSON.stringify(BENIGN, null, 1));
console.log(
  `carriers=${CARRIERS.length} (reg ${CARRIERS.filter((c) => c.cat === "reg").length} / new ${CARRIERS.filter((c) => c.cat === "new").length}, new families ${new Set(CARRIERS.filter((c) => c.cat === "new").map((c) => c.family)).size}) benign=${BENIGN.length} (reg ${BENIGN.filter((b) => b.cat === "reg").length} / new ${BENIGN.filter((b) => b.cat === "new").length})`
);
