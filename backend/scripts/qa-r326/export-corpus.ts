// R326：复用 R325 盲测语料（V / L / B / Q）与读实现载体，导出到 qa-r326/out/（不进仓库），供 prod/*.mjs 跑生产复测。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, Q, V, L, B } from "../qa-r325/blind-carriers";
import { INFORMED } from "../qa-r325/informed-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(Q, null, 1));
writeFileSync(`${OUT}/informed.json`, JSON.stringify(INFORMED, null, 1));
console.log(`blind=${ALL.length} V=${V.length} L=${L.length} B=${B.length} (retrieve=${B.filter((b) => b.id.startsWith("BR")).length}) oracle=${Q.length} informed=${INFORMED.length}`);
