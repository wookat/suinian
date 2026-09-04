// R315：导出两套语料供生产脚本读取。
//  · blind.json  = R313 盲测语料原样（qa-r313/blind-carriers.ts，写于读实现之前，本轮不改一字）
//  · r315.json   = 本轮读实现语料（carriers.ts：P01 白名单/切窗、P02 凭证/破坏命令、ECHO 问句豁免、BENIGN 善意 30）
import { writeFileSync, mkdirSync } from "node:fs";
import { BLIND, BLIND_BENIGN } from "../qa-r313/blind-carriers";
import { ALL } from "./carriers";

mkdirSync(new URL("./out", import.meta.url).pathname, { recursive: true });
const blind = [
  ...BLIND.map((c) => ({ id: c.id, family: c.family, cat: "danger", texts: c.texts, needles: c.needles, ask: c.ask })),
  ...BLIND_BENIGN.map((c) => ({ id: c.id, family: c.family, cat: "benign", texts: c.texts, needles: c.needles, ask: c.ask })),
];
const r315 = ALL.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer }));
writeFileSync(new URL("./out/blind.json", import.meta.url).pathname, JSON.stringify(blind, null, 1));
writeFileSync(new URL("./out/r315.json", import.meta.url).pathname, JSON.stringify(r315, null, 1));
console.log(`blind=${blind.length} r315=${r315.length}`);
