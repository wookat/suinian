/**
 * R330 跨单元拼接候选的善意扫描：善意语料按召回窗口（连续 5 条）送入 sourceValueCandidates，
 * 列出「只在拼接面才出现」的候选（jointOnly）——即 jointHeadOrders 对善意召回集的误伤面。
 * 运行：cd backend && npx tsx scripts/qa-r330/probe-joint-benign.ts
 */
import { sourceValueCandidates, normalizeForLeakCompare } from "../../src/prompt-armor";
import { B as B329 } from "../qa-r329/blind-carriers";
import { B as B327 } from "../qa-r327/blind-carriers";
import { BENIGN as R309 } from "../qa-r309/benign";
import { BENIGN_CASES as INJ } from "../injection-eval-data";
import { BENIGN_R288_CASES } from "../r288-eval-data";
import { BENIGN_INSTALLERS, BENIGN_DOCS } from "../r290-eval-data";
import { NOTES as ASK_NOTES } from "../ask-eval-data";

const rows = [
  ...B329.flatMap((c) => c.texts.map((t, i) => ({ id: `r329/${c.id}#${i}`, text: t }))),
  ...B327.flatMap((c) => c.texts.map((t, i) => ({ id: `r327/${c.id}#${i}`, text: t }))),
  ...R309.map((c) => ({ id: `r309/${c.id}`, text: c.text })),
  ...INJ.map((c) => ({ id: `inj/${c.id}`, text: c.note })),
  ...BENIGN_R288_CASES.map((c) => ({ id: `r288/${c.id}`, text: c.text })),
  ...BENIGN_INSTALLERS.map((c) => ({ id: `r290i/${c.id}`, text: c.text })),
  ...BENIGN_DOCS.map((c) => ({ id: `r290d/${c.id}`, text: c.text })),
  ...ASK_NOTES.filter((n) => !n.sensitive).map((n) => ({ id: `ask/${n.key}`, text: `${n.title}\n${n.content}` })),
].filter((r) => r.text);
const W = 5;
let windows = 0;
let withJoin = 0;
const hits: string[] = [];
for (let i = 0; i + W <= rows.length; i += 1) {
  const win = rows.slice(i, i + W);
  const units = win.map((r) => r.text);
  windows += 1;
  const single = new Set(units.flatMap((u) => sourceValueCandidates([u]).map((c) => normalizeForLeakCompare(c.value))));
  const joint = sourceValueCandidates(units).map((c) => c.value).filter((v) => !single.has(normalizeForLeakCompare(v)));
  if (joint.length > 0) {
    withJoin += 1;
    hits.push(`${win.map((r) => r.id).join(",")} -> ${joint.slice(0, 8).join("|")}${joint.length > 8 ? ` (+${joint.length - 8})` : ""}`);
  }
}
console.log(`rows=${rows.length} windows=${windows} windows_with_joint=${withJoin}`);
for (const h of hits) console.log(h);
