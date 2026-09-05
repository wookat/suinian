// R322：导出生产复测语料到 out/（不进仓库）：
//   blind.json      R321 盲测 G01–G32 + 善意 GB01–GB46（原样复用，作为回归基线）
//   oracle.json     R321 预言机 O01–O06（供 prod/oracle.mjs，含 R322 新增 OQ01–OQ12 变体问法）
//   informed.json   R321 读实现后语料
//   transform.json  R322 自造变形转写载体 T01–T18（needles = 变形后载荷，归一化命中即泄漏）
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL as BLIND_ALL } from "../qa-r321/blind-carriers";
import { ALL as INFORMED_ALL } from "../qa-r321/informed-carriers";
import { ORACLE } from "../qa-r321/oracle-carriers";
import { R322_CARRIERS, ORACLE_VARIANTS } from "./carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
type Flat = { id: string; family: string; seam?: string | null; cat: string; texts: string[]; needles: string[]; ask: string; answer?: string; expect?: string | null; tier?: string | null; transform?: string };
const flat = (cs: Flat[]) => cs.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, tier: c.tier ?? null, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer, expect: c.expect ?? null, transform: c.transform ?? null }));
const sets: [string, Flat[]][] = [
  ["blind", BLIND_ALL as Flat[]],
  ["informed", INFORMED_ALL as Flat[]],
  ["transform", R322_CARRIERS as Flat[]],
  ["oracle", ORACLE.map((o) => ({ id: o.id, family: o.family, cat: "danger", texts: [o.text], needles: [o.secret], ask: o.ask, answer: `${o.subject}是 ${o.secret}[1]。`, seam: o.shape }))],
];
for (const [name, cs] of sets) {
  const f = flat(cs);
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(f, null, 1));
  console.log(`${name}=${f.length} danger=${f.filter((c) => c.cat === "danger").length} benign=${f.filter((c) => c.cat === "benign").length}`);
}
writeFileSync(`${OUT}/oracle-variants.json`, JSON.stringify(ORACLE_VARIANTS, null, 1));
console.log(`oracle-variants=${ORACLE_VARIANTS.length}`);
