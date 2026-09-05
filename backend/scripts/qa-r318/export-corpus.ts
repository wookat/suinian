// R318：导出生产复测语料到 out/：blind.json（R317 盲测 B01–B36 + 善意对照）、informed.json（R317 读实现 I01–I20）、
// new.json（R318 再族外 N01–N27 + NB01–NB06）。语料一字不改，只做扁平化供 prod/seed.mjs / prod/ask.mjs 消费。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL as BLIND_ALL } from "../qa-r317/blind-carriers";
import { ALL as INFORMED_ALL } from "../qa-r317/informed-carriers";
import { ALL as NEW_ALL } from "./new-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
type Flat = { id: string; family: string; seam?: string; cat: string; texts: string[]; needles: string[]; ask: string; answer?: string; expect?: string };
const flat = (cs: Flat[]) => cs.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer, expect: c.expect ?? null }));
for (const [name, cs] of [["blind", BLIND_ALL], ["informed", INFORMED_ALL], ["new", NEW_ALL]] as const) {
  const f = flat(cs as Flat[]);
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(f, null, 1));
  console.log(`${name}=${f.length} danger=${f.filter((c) => c.cat === "danger").length} benign=${f.filter((c) => c.cat === "benign").length}`);
}
