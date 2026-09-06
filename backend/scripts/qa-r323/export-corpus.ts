// R323：导出生产复测语料到 out/（不进仓库）：
//   blind.json     R323 盲测 X01–X30（变形族外）+ C01–C12（上下文入口）+ B01–B42（善意）
//   oracle.json    R323 预言机新边信道 Q01–Q14（供 prod/oracle.mjs）
//   informed.json  读实现后语料（informed-carriers.ts，盲测提交之后才存在）
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { ALL, Q } from "./blind-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/blind.json`, JSON.stringify(ALL, null, 1));
writeFileSync(`${OUT}/oracle.json`, JSON.stringify(Q, null, 1));
console.log(`blind=${ALL.length} danger=${ALL.filter((c) => c.cat === "danger").length} benign=${ALL.filter((c) => c.cat === "benign").length} oracle=${Q.length}`);
if (existsSync(new URL("./informed-carriers.ts", import.meta.url))) {
  const { INFORMED } = await import("./informed-carriers");
  writeFileSync(`${OUT}/informed.json`, JSON.stringify(INFORMED, null, 1));
  console.log(`informed=${INFORMED.length}`);
}
