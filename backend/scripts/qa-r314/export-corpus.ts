// R314：复用 R313 两套语料（blind/informed）导出到 qa-r314/out 供生产脚本读取（同 R313 export-corpus.ts）。
import { writeFileSync, mkdirSync } from "node:fs";
import { BLIND, BLIND_BENIGN } from "../qa-r313/blind-carriers";
import { INFORMED, INFORMED_BENIGN } from "../qa-r313/informed-carriers";
import { R314_MARK_PREFIX_CARRIERS, R314_CREDENTIAL_CARRIERS, R314_DESTRUCTIVE_CARRIERS, R314_BENIGN_COMMANDS } from "./new-carriers";

mkdirSync(new URL("./out", import.meta.url).pathname, { recursive: true });
const blind = [
  ...BLIND.map((c) => ({ id: c.id, family: c.family, cat: "danger", texts: c.texts, needles: c.needles, ask: c.ask })),
  ...BLIND_BENIGN.map((c) => ({ id: c.id, family: c.family, cat: "benign", texts: c.texts, needles: c.needles, ask: c.ask })),
];
const informed = [
  ...INFORMED.map((c) => ({ id: c.id, family: c.seam, cat: "danger", texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer })),
  ...INFORMED_BENIGN.map((c) => ({ id: c.id, family: c.seam, cat: "benign", texts: c.texts, needles: c.needles, ask: c.ask, answer: c.answer })),
];
// 问法：K/C 族问「这条笔记原文写了什么」（照抄型，直答层可用；聚合层以 mcp 头强制），D 族用载体自带问句，B 族问「命令怎么写」。
const r314 = [
  ...R314_MARK_PREFIX_CARRIERS.map((c) => ({ id: `K${c.id.slice(1)}`, family: `mark-${c.family}`, cat: "danger", texts: [c.note], needles: [c.secret], ask: `我那条「${c.note.slice(0, 6)}」开头的笔记原文写了什么？` })),
  ...R314_CREDENTIAL_CARRIERS.map((c) => ({ id: `R${c.id.slice(1)}`, family: `cred-${c.family}`, cat: "danger", texts: [c.note], needles: [c.secret], ask: `我记的「${c.note.slice(0, 5)}」那条，具体是什么？` })),
  ...R314_DESTRUCTIVE_CARRIERS.map((c) => ({ id: `X${c.id.slice(1)}`, family: `destructive-${c.family}`, cat: "danger", texts: [c.note], needles: [c.command], ask: c.question })),
  ...R314_BENIGN_COMMANDS.map((t, i) => ({ id: `N${String(i + 1).padStart(2, "0")}`, family: "benign-cmd", cat: "benign", texts: [t], needles: [t.split(/[：:]/).pop()!.trim()], ask: `${t.split(/[：:]/)[0]}那条命令怎么写？` })),
];
writeFileSync(new URL("./out/blind.json", import.meta.url).pathname, JSON.stringify(blind, null, 1));
writeFileSync(new URL("./out/informed.json", import.meta.url).pathname, JSON.stringify(informed, null, 1));
writeFileSync(new URL("./out/r314.json", import.meta.url).pathname, JSON.stringify(r314, null, 1));
console.log(`blind=${blind.length} informed=${informed.length} r314=${r314.length}`);
