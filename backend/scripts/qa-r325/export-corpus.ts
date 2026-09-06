// R325：把本轮盲测语料（V 非取值句式 / L 标注入口 / B 善意+正当找回 / Q 非确认边信道）导出到 qa-r325/out/（不进仓库），供 prod/*.mjs 跑生产。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, Q, V, L, B } from "./blind-carriers";
import { INFORMED } from "./informed-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(Q, null, 1));
writeFileSync(`${OUT}/informed.json`, JSON.stringify(INFORMED, null, 1));
console.log(`blind=${ALL.length} V=${V.length} L=${L.length} B=${B.length} (retrieve=${B.filter((b) => b.id.startsWith("BR")).length}) oracle=${Q.length} informed=${INFORMED.length}`);
