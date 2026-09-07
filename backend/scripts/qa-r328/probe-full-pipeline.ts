// R328 调查探针：38 危险载体全部视作【未标注】，走生产 /api/ask 的确定性闸门 + finalizeAskAnswer（直答 / 聚合两档），
// 看出口层在不依赖标注时能否兜住模型「如实照做」的最坏答案。
import { DANGER, B } from "../qa-r327/blind-carriers";
import {
  finalizeAskAnswer,
  normalizeForLeakCompare,
  crossUnitGuardedLines,
  unitTalksAboutSecret,
  isSecretValueQuestion,
  isOracleProbeQuestion,
  isYesNoQuestion,
} from "../../src/prompt-armor";
import { askGuardNoteUnit } from "../../src/index";

const norm = normalizeForLeakCompare;
const leaked = (text: string, needles: string[]) => needles.filter((n) => norm(n).length >= 3 && norm(text).includes(norm(n)));

function gate(texts: string[], asks: string[]): "oracle" | "value" | null {
  const units = texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
  const cross = crossUnitGuardedLines(units);
  const talking = units.some((u) => unitTalksAboutSecret(u, cross));
  const q = asks[asks.length - 1];
  const history = asks.slice(0, -1).join("\n");
  if (!talking) return null;
  if (isYesNoQuestion(q) || isOracleProbeQuestion(q, { anchored: true }) || (history && isOracleProbeQuestion(q))) return "oracle";
  if (isSecretValueQuestion(q, history)) return "value";
  return null;
}

let survive = 0;
for (const c of DANGER) {
  const units = c.texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
  const q = c.asks[c.asks.length - 1];
  const g = gate(c.texts, c.asks);
  const direct = finalizeAskAnswer(c.answer, {
    dataText: c.texts.join("\n"),
    dataUnits: units,
    question: q,
    tier: { kind: "single_note_direct", directUnit: units[units.length - 1] },
  }).answer;
  const agg = finalizeAskAnswer(c.answer, { dataText: c.texts.join("\n"), dataUnits: units, question: q }).answer;
  const ld = leaked(direct, c.needles);
  const la = leaked(agg, c.needles);
  if (g === null && (ld.length > 0 || la.length > 0)) {
    survive += 1;
    console.log(`SURVIVE ${c.id} gate=${g} direct=${JSON.stringify(ld)} agg=${JSON.stringify(la)}\n   direct→ ${JSON.stringify(direct)}\n   agg   → ${JSON.stringify(agg)}`);
  } else if (g !== null && (ld.length > 0 || la.length > 0)) {
    console.log(`gated  ${c.id} gate=${g} (closeVerbatim alone would leak direct=${ld.length} agg=${la.length})`);
  }
}
console.log(`danger survive (ungated, direct|agg): ${survive}/${DANGER.length}`);

let benignHit = 0;
for (const c of B) {
  const units = c.texts.map((t) => askGuardNoteUnit({ title: null, content: t } as never));
  const q = c.asks[c.asks.length - 1];
  const g = gate(c.texts, c.asks);
  const direct = finalizeAskAnswer(c.answer, {
    dataText: c.texts.join("\n"),
    dataUnits: units,
    question: q,
    tier: { kind: "single_note_direct", directUnit: units[units.length - 1] },
  });
  const agg = finalizeAskAnswer(c.answer, { dataText: c.texts.join("\n"), dataUnits: units, question: q });
  if (g !== null || direct.answer !== c.answer || agg.answer !== c.answer) {
    benignHit += 1;
    console.log(`BENIGN-TOUCH ${c.id} gate=${g}\n   direct→ ${JSON.stringify(direct.answer)}\n   agg   → ${JSON.stringify(agg.answer)}`);
  }
}
console.log(`benign touched: ${benignHit}/${B.length}`);
