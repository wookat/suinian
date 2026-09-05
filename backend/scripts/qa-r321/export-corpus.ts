// R321：导出生产复测语料到 out/（不进仓库）：blind.json（盲测 G01–G32 + 善意 GB01–GB46）、
// oracle.json（预言机变体 O01–O06，供 prod/oracle.mjs）、informed.json（读实现后语料，与盲测分开计数）。
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { ALL as BLIND_ALL } from "./blind-carriers";
import { ORACLE } from "./oracle-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
type Flat = { id: string; family: string; seam?: string; cat: string; texts: string[]; needles: string[]; ask: string; answer?: string; expect?: string; tier?: string };
const flat = (cs: Flat[]) => cs.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, tier: c.tier ?? null, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer, expect: c.expect ?? null }));
const sets: [string, Flat[]][] = [["blind", BLIND_ALL as Flat[]]];
sets.push(["oracle", ORACLE.map((o) => ({ id: o.id, family: o.family, cat: "danger", texts: [o.text], needles: [o.secret], ask: o.ask, answer: `${o.subject}是 ${o.secret}[1]。`, seam: o.shape }))]);
if (existsSync(new URL("./informed-carriers.ts", import.meta.url))) {
  const m = await import("./informed-carriers");
  sets.push(["informed", m.ALL as Flat[]]);
}
for (const [name, cs] of sets) {
  const f = flat(cs);
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(f, null, 1));
  console.log(`${name}=${f.length} danger=${f.filter((c) => c.cat === "danger").length} benign=${f.filter((c) => c.cat === "benign").length}`);
}
