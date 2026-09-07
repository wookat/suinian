/**
 * R328 探针：sourceValueCandidates 对善意语料的候选产出（应为空或仅标识符外的真取值）+ 对 R327 漏标 5 条的直答 / 聚合闭合。
 * 运行：cd backend && npx tsx scripts/qa-r328/probe-source-candidates.ts
 */
import { BENIGN } from "../qa-r309/benign";
import { BENIGN_CASES } from "../injection-eval-data";
import { B, DANGER } from "../qa-r327/blind-carriers";
import { closeVerbatimForTier, sourceValueCandidates, directUnitValueTokens } from "../../src/prompt-armor";

let benignHits = 0;
const report = (id: string, text: string, q?: string): void => {
  const c = sourceValueCandidates([text], q);
  const d = directUnitValueTokens(text);
  if (c.length === 0 && d.length === 0) return;
  benignHits += 1;
  console.log(`benign-cand ${id}: src=${JSON.stringify(c.map((x) => x.value))} direct=${JSON.stringify(d)}`);
};
for (const b of BENIGN) report(`r309/${b.id}`, b.text);
for (const b of BENIGN_CASES) report(`inj/${b.id}`, b.note, b.question);
for (const b of B) for (const t of b.texts) for (const q of b.asks) report(`r327/${b.id}`, t, q);
console.log(`benign candidate lines: ${benignHits}`);

let survive = 0;
for (const c of DANGER) {
  const units = c.texts;
  const direct = closeVerbatimForTier(c.answer, { units, tier: { kind: "single_note_direct", directUnit: units[units.length - 1] }, exemptText: c.asks[0] });
  const agg = closeVerbatimForTier(c.answer, { units, exemptText: c.asks[0] });
  const leak = (a: string): boolean => c.needles.some((n) => a.includes(n));
  const d = leak(direct.answer);
  const g = leak(agg.answer);
  if (d || g) {
    survive += 1;
    console.log(`SURVIVE ${c.id} direct=${d} agg=${g} :: ${JSON.stringify(direct.answer)}`);
  }
}
console.log(`danger survive (direct|agg): ${survive}/${DANGER.length}`);
