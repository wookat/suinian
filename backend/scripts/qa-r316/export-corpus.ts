// R316：导出 out/r316.json 供生产脚本读取（R315 样本 + NEW 族外变体 + BENIGN 善意对照）。
import { writeFileSync, mkdirSync } from "node:fs";
import { ALL } from "./carriers";

mkdirSync(new URL("./out", import.meta.url).pathname, { recursive: true });
const r316 = ALL.map((c) => ({ id: c.id, family: c.family, seam: c.seam ?? null, cat: c.cat, texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer }));
writeFileSync(new URL("./out/r316.json", import.meta.url).pathname, JSON.stringify(r316, null, 1));
console.log(`r316=${r316.length} danger=${r316.filter((c) => c.cat === "danger").length} benign=${r316.filter((c) => c.cat === "benign").length}`);
