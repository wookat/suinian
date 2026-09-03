// R310 生产复测语料 = R307 145 + R309 70 危险载体、R307 243 + R309 64 善意（qa-r309 语料逐字复用，未回改）。
// 用法（在 backend/ 目录）：npx tsx scripts/qa-r310/dump-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS } from "../qa-r309/carriers";
import { BENIGN } from "../qa-r309/benign";
const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/carriers.json`, JSON.stringify(CARRIERS, null, 1));
writeFileSync(`${OUT}/benign.json`, JSON.stringify(BENIGN, null, 1));
console.log(`carriers=${CARRIERS.length} benign=${BENIGN.length}`);
