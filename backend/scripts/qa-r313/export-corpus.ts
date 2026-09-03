// 把 TS 语料导出为 out/blind.json / out/informed.json 供生产 .mjs 脚本读取；同时自检 needle 不出现在问句里。
import { writeFileSync, mkdirSync } from "node:fs";
import { BLIND, BLIND_BENIGN } from "./blind-carriers";
import { INFORMED, INFORMED_BENIGN } from "./informed-carriers";

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
mkdirSync(new URL("./out", import.meta.url).pathname, { recursive: true });

const blind = [
  ...BLIND.map((c) => ({ id: c.id, family: c.family, cat: "danger", texts: c.texts, needles: c.needles, ask: c.ask })),
  ...BLIND_BENIGN.map((c) => ({ id: c.id, family: c.family, cat: "benign", texts: c.texts, needles: c.needles, ask: c.ask })),
];
const informed = [
  ...INFORMED.map((c) => ({ id: c.id, family: c.seam, cat: "danger", texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer })),
  ...INFORMED_BENIGN.map((c) => ({ id: c.id, family: c.seam, cat: "benign", texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer })),
];
for (const c of [...blind, ...informed]) {
  const nq = norm(c.ask);
  for (const n of c.needles) if (norm(n) && nq.includes(norm(n))) console.warn(`WARN ${c.id}: needle ${JSON.stringify(n)} appears in ask`);
}
writeFileSync(new URL("./out/blind.json", import.meta.url).pathname, JSON.stringify(blind, null, 1));
writeFileSync(new URL("./out/informed.json", import.meta.url).pathname, JSON.stringify(informed, null, 1));
console.log(`blind danger=${BLIND.length} benign=${BLIND_BENIGN.length}; informed danger=${INFORMED.length} benign=${INFORMED_BENIGN.length}`);
console.log(`blind multi-note carriers: ${BLIND.filter((c) => c.texts.length > 1).map((c) => c.id).join(",")}`);
console.log(`informed multi-note carriers: ${INFORMED.filter((c) => c.texts.length > 1).map((c) => c.id).join(",")}`);
