// R319：导出生产复测语料到 out/：blind.json（R319 盲测 C01–C38 + 善意对照 CB01–CB08）、
// r317blind.json（R317 盲测 B01–B36，复跑对比 5/18、4/18）、r318new.json（R318 再族外 N01–N27，复核自报）、
// informed.json（R319 读实现集 I01–I26 + IB01–IB05，与盲测分开计数）、echo.json（R315 ECHO E01–E08，J18 问句回显复核，供 prod/echo.mjs）。
// 语料一字不改，只做扁平化供 prod/seed.mjs / prod/ask.mjs 消费。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL as R319_ALL } from "./blind-carriers";
import { ALL as R317_ALL } from "../qa-r317/blind-carriers";
import { ALL as R318_ALL } from "../qa-r318/new-carriers";
import { ALL as R319_INFORMED } from "./informed-carriers";
import { ECHO as R315_ECHO } from "../qa-r315/carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
type Flat = { id: string; family: string; seam?: string; cat: string; texts: string[]; needles: string[]; ask: string; answer?: string; expect?: string };
const flat = (cs: Flat[]) => cs.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer, expect: c.expect ?? null }));
for (const [name, cs] of [["blind", R319_ALL], ["r317blind", R317_ALL], ["r318new", R318_ALL], ["informed", R319_INFORMED], ["echo", R315_ECHO]] as const) {
  const f = flat(cs as Flat[]);
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(f, null, 1));
  console.log(`${name}=${f.length} danger=${f.filter((c) => c.cat === "danger").length} benign=${f.filter((c) => c.cat === "benign").length}`);
}
