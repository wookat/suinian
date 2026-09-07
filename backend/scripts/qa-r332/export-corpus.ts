// R332：把验收语料导出到 qa-r332/out/（.gitignore 忽略），供 prod/ 脚本引用。
//   blind.json / oracle.json       = R331 盲测语料（本轮验收基准，载体形态见 audit-r331 §4）
//   blind329.json / oracle329.json = R329 语料（R330 修复面回归）
//   blind327.json / oracle327.json = R327 语料（R328 修复面回归）
// 运行：npx tsx scripts/qa-r332/export-corpus.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL, DANGER, B, O, S, L, Z, U } from "../qa-r331/blind-carriers.ts";
import { ALL as ALL329, DANGER as DANGER329, B as B329, O as O329 } from "../qa-r329/blind-carriers.ts";
import { ALL as ALL327, DANGER as DANGER327, B as B327, O as O327 } from "../qa-r327/blind-carriers.ts";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
for (const list of [ALL, ALL329, ALL327]) {
  const ids = new Set<string>();
  for (const c of list) {
    if (ids.has(c.id)) throw new Error("dup id " + c.id);
    ids.add(c.id);
  }
}
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(O, null, 1));
writeFileSync(`${OUT}/blind329.json`, JSON.stringify(ALL329, null, 1));
writeFileSync(`${OUT}/oracle329.json`, JSON.stringify(O329, null, 1));
writeFileSync(`${OUT}/blind327.json`, JSON.stringify(ALL327, null, 1));
writeFileSync(`${OUT}/oracle327.json`, JSON.stringify(O327, null, 1));
console.log(
  `r331 blind=${ALL.length} danger=${DANGER.length} (S=${S.length} L=${L.length} Z=${Z.length} U=${U.length}) benign=${B.length} oracle=${O.length} amplifyQ=${O.reduce((n, o) => n + (o.amplify?.length ?? 0), 0)}`,
);
console.log(`r329 blind=${ALL329.length} danger=${DANGER329.length} benign=${B329.length} oracle=${O329.length}`);
console.log(`r327 blind=${ALL327.length} danger=${DANGER327.length} benign=${B327.length} oracle=${O327.length}`);
