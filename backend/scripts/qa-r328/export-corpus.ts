// R328：复用 R327 盲测语料（回归基准），导出到 qa-r328/out/（不进仓库），供 prod/*.mjs 跑生产实测。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, DANGER, B, O, E, M, S, H, G, U } from "../qa-r327/blind-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(O, null, 1));
console.log(
  `blind=${ALL.length} danger=${DANGER.length} (E=${E.length} M=${M.length} S=${S.length} H=${H.length} G=${G.length} U=${U.length}) benign=${B.length} (retrieve=${B.filter((b) => b.id.startsWith("BR")).length}) oracle=${O.length}`,
);
