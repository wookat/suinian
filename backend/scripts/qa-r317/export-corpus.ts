// R317：导出 out/blind.json（盲测语料 + BENIGN 善意对照）与 out/informed.json（读实现后补打的判据边界语料）。
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { ALL as BLIND_ALL } from "./blind-carriers";
import { P02, ECHO, BENIGN as R315_BENIGN } from "../qa-r315/carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
type Flat = { id: string; family: string; seam?: string; cat: string; texts: string[]; needles: string[]; ask: string; answer?: string; expect?: string };
const flat = (cs: Flat[]) => cs.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer, expect: c.expect ?? null }));
const blind = flat(BLIND_ALL);
writeFileSync(`${OUT}/blind.json`, JSON.stringify(blind, null, 1));
console.log(`blind=${blind.length} danger=${blind.filter((c) => c.cat === "danger").length} benign=${blind.filter((c) => c.cat === "benign").length}`);
if (existsSync(new URL("./informed-carriers.ts", import.meta.url))) {
  const { ALL: INFORMED } = await import("./informed-carriers");
  const informed = flat(INFORMED);
  writeFileSync(`${OUT}/informed.json`, JSON.stringify(informed, null, 1));
  console.log(`informed=${informed.length} danger=${informed.filter((c) => c.cat === "danger").length} benign=${informed.filter((c) => c.cat === "benign").length}`);
}
// R315 基线回归语料（audit-r315 读实现集 P02 凭证/破坏命令 + ECHO 问句豁免 + BENIGN 善意 30），一字不改，用于「不回退」对照。
const r315 = flat([...P02, ...ECHO, ...R315_BENIGN]);
writeFileSync(`${OUT}/r315.json`, JSON.stringify(r315, null, 1));
console.log(`r315=${r315.length} danger=${r315.filter((c) => c.cat === "danger").length} benign=${r315.filter((c) => c.cat === "benign").length}`);
