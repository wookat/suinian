/**
 * R330 善意候选面扫描：把仓库内全部善意语料喂给 sourceValueCandidates（不带问句 / 带取值型问句两态），
 * 列出产生候选的条目——与基线 main 上同一探针对比，新增条目即 R330 的误伤代价，须在 decision-r330 §2.3 逐条论证。
 * 运行：cd backend && npx tsx scripts/qa-r330/probe-benign-sweep.ts
 */
import { sourceValueCandidates } from "../../src/prompt-armor";
import { B as B329 } from "../qa-r329/blind-carriers";
import { B as B327 } from "../qa-r327/blind-carriers";
import { BENIGN as R309 } from "../qa-r309/benign";
import { BENIGN_CASES as INJ } from "../injection-eval-data";
import { BENIGN_R288_CASES } from "../r288-eval-data";
import { BENIGN_INSTALLERS, BENIGN_DOCS } from "../r290-eval-data";
import { NOTES as ASK_NOTES } from "../ask-eval-data";

type Row = { id: string; text: string };
const rows: Row[] = [
  ...B329.map((c) => ({ id: `r329/${c.id}`, text: c.texts[0] })),
  ...B327.map((c) => ({ id: `r327/${c.id}`, text: c.texts[0] })),
  ...R309.map((c) => ({ id: `r309/${c.id}`, text: c.text })),
  ...INJ.map((c) => ({ id: `inj/${c.id}`, text: c.note })),
  ...BENIGN_R288_CASES.map((c) => ({ id: `r288/${c.id}`, text: c.text })),
  ...BENIGN_INSTALLERS.map((c) => ({ id: `r290i/${c.id}`, text: c.text })),
  ...BENIGN_DOCS.map((c) => ({ id: `r290d/${c.id}`, text: c.text })),
  ...ASK_NOTES.filter((n) => !n.sensitive).map((n) => ({ id: `ask/${n.key}`, text: `${n.title}\n${n.content}` })),
].filter((r) => r.text);

const hits: string[] = [];
for (const r of rows) {
  const c = sourceValueCandidates([r.text]).map((x) => x.value);
  if (c.length > 0) hits.push(`${r.id}${JSON.stringify(c)}`);
}
console.log(`rows=${rows.length} with_candidates=${hits.length}`);
for (const h of hits) console.log(h);
