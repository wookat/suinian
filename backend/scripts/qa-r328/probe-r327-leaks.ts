/**
 * R328 调查探针：R327 4/38 直答漏出 + MCP notes[] 漏出的载体，在本地确定性出口层上到底走到了哪一步。
 * 用法：npx tsx scripts/qa-r328/probe-r327-leaks.ts
 */
import { E, M, S, H, G, U, B } from "../qa-r327/blind-carriers";
import {
  closeVerbatimForTier,
  resolveAskTrustTier,
  AGGREGATE_TIER,
  directGuardLines,
  broadFoldReason,
  opaqueTokensOf,
  isSecretValueQuestion,
  unitTalksAboutSecret,
  normalizedGuardedLeak,
} from "../../src/prompt-armor";
import { detectSensitive, maybeSensitive } from "../../src/triage";

const all = [...E, ...M, ...S, ...H, ...G, ...U];
const focus = new Set(["H01", "H02", "H06", "G04", "G06", "S05", "G07", "E02"]);
for (const c of all) {
  if (!focus.has(c.id)) continue;
  const unit = c.texts.join("\n");
  const q = c.asks[0];
  const direct = closeVerbatimForTier(c.answer, { units: c.texts, tier: resolveAskTrustTier([unit], "app"), exemptText: q });
  const agg = closeVerbatimForTier(c.answer, { units: c.texts, tier: AGGREGATE_TIER, exemptText: q });
  console.log(`\n== ${c.id} ${c.family}`);
  console.log(`  text: ${JSON.stringify(unit)}`);
  console.log(`  detect=${c.texts.some(detectSensitive)} maybe=${c.texts.some(maybeSensitive)} broadFold=${broadFoldReason(unit)} guardLines=${JSON.stringify(directGuardLines(unit))}`);
  console.log(`  opaque=${JSON.stringify(opaqueTokensOf(unit))} secretQ=${isSecretValueQuestion(q)} talksSecret=${unitTalksAboutSecret(unit)} normLeak=${normalizedGuardedLeak(c.answer, c.texts)}`);
  console.log(`  answer: ${JSON.stringify(c.answer)}`);
  console.log(`  direct→ ${JSON.stringify(direct.answer)} (count=${direct.count})`);
  console.log(`  agg   → ${JSON.stringify(agg.answer)} (count=${agg.count})`);
}

console.log("\n== benign direct-tier LCS8 cost (if aggregate closure applied to single-note direct)");
let closed = 0;
let n = 0;
for (const c of B) {
  const unit = c.texts.join("\n");
  n++;
  const agg = closeVerbatimForTier(c.answer, { units: c.texts, tier: AGGREGATE_TIER, exemptText: c.asks[0] });
  const direct = closeVerbatimForTier(c.answer, { units: c.texts, tier: resolveAskTrustTier([unit], "app"), exemptText: c.asks[0] });
  if (agg.count > 0) closed++;
  console.log(`${c.id}\tagg=${agg.count > 0 ? "CLOSED" : "-"}\tdirect=${direct.count > 0 ? "CLOSED" : "-"}\tsecretQ=${isSecretValueQuestion(c.asks[0]) ? "Y" : "-"}\ttalks=${unitTalksAboutSecret(unit) ? "Y" : "-"}\t${JSON.stringify(c.answer).slice(0, 60)}`);
}
console.log(`benign n=${n} aggregate-closed=${closed}`);
