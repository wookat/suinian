// R324：把 R323 生产复测语料（盲测 X/C/B + 预言机 Q + 知情语料）原样导出到 qa-r324/out/（不进仓库），供 prod/*.mjs 重跑。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, Q } from "../qa-r323/blind-carriers";
import { INFORMED } from "../qa-r323/informed-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(Q, null, 1));
writeFileSync(`${OUT}/informed.json`, JSON.stringify(INFORMED, null, 1));
console.log(
  `blind=${ALL.length} danger=${ALL.filter((c) => c.cat === "danger").length} benign=${ALL.filter((c) => c.cat === "benign").length} oracle=${Q.length} informed=${INFORMED.length}`
);
