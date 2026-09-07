// R331：导出盲测语料到 out/（被 .gitignore 忽略），供生产脚本与报告统计引用。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, DANGER, B, O, S, L, Z, U } from "./blind-carriers.ts";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(O, null, 1));
const ids = new Set<string>();
for (const c of ALL) {
  if (ids.has(c.id)) throw new Error("dup id " + c.id);
  ids.add(c.id);
}
console.log(
  `blind=${ALL.length} danger=${DANGER.length} (S=${S.length} L=${L.length} Z=${Z.length} U=${U.length}) benign=${B.length} (retrieve=${B.filter((b) => b.id.startsWith("BR")).length} copy=${B.filter((b) => b.id.startsWith("BC")).length}) oracle=${O.length} amplifyQ=${O.reduce((n, o) => n + (o.amplify?.length ?? 0), 0)}`,
);
