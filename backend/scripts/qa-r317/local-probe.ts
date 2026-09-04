// R317 本地纯函数探针（不经模型）：直调 R316 导出的判据函数，量「模型如实复述」最坏输入下
// 直答层（closeVerbatimForTier tier=single_note_direct + markDestructiveCommandLines）与聚合层（closeAggregateVerbatim）
// 对盲测 / 读实现语料的收口结果。与生产实测并列报告；生产为准，本地用于定位是判据未覆盖还是模型改写所致。
// 用法：npx tsx scripts/qa-r317/local-probe.ts
import { writeFileSync, mkdirSync } from "node:fs";
import {
  credentialValueTokens,
  closeCredentialValues,
  destructiveCommandFamily,
  markDestructiveCommandLines,
  closeAggregateVerbatim,
  closeVerbatimForTier,
  broadFoldReason,
} from "../../src/prompt-armor";
import { ALL as BLIND } from "./blind-carriers";
import { ALL as INFORMED } from "./informed-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]) => needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));
const DESTR_MARK = "〔警示：以下为破坏性命令";

type Row = {
  id: string; family: string; cat: string; seam: string | null;
  fold_reason: string | null; destr_family: string | null; cred_tokens: string[];
  direct_answer: string; direct_survive: string[]; direct_warned: boolean;
  agg_answer: string; agg_survive: string[];
};
const rows: Row[] = [];
for (const [corpus, items] of [["blind", BLIND], ["informed", INFORMED]] as const) {
  for (const c of items) {
    const units = c.texts;
    const direct = units[0];
    const tier = { kind: "single_note_direct", directUnit: direct } as unknown as Parameters<typeof closeVerbatimForTier>[1]["tier"];
    const d = closeVerbatimForTier(c.answer, { units, tier, exemptText: c.ask });
    const dm = markDestructiveCommandLines(d.answer, units);
    const a = closeAggregateVerbatim(c.answer, units);
    rows.push({
      id: c.id, family: c.family, cat: c.cat, seam: c.seam ?? null,
      fold_reason: broadFoldReason(direct), destr_family: destructiveCommandFamily(direct),
      cred_tokens: units.flatMap((u) => credentialValueTokens(u)),
      direct_answer: dm.answer, direct_survive: hits(dm.answer, c.needles), direct_warned: dm.answer.includes(DESTR_MARK),
      agg_answer: a.answer, agg_survive: hits(a.answer, c.needles),
    });
    void closeCredentialValues;
  }
  writeFileSync(`${OUT}/local-probe-${corpus}.json`, JSON.stringify(rows.filter((r) => items.some((c) => c.id === r.id)), null, 1));
}
for (const corpus of ["blind", "informed"]) {
  const items = corpus === "blind" ? BLIND : INFORMED;
  const rs = rows.filter((r) => items.some((c) => c.id === r.id));
  const danger = rs.filter((r) => r.cat === "danger");
  const cred = danger.filter((r) => /cred/.test(r.family));
  const destr = danger.filter((r) => /destructive/.test(r.family));
  console.log(`\n== ${corpus}: danger=${danger.length} cred=${cred.length} destr=${destr.length} benign=${rs.length - danger.length}`);
  console.log(`[cred/direct] literal=${cred.filter((r) => r.direct_survive.length).length}/${cred.length}: ${cred.filter((r) => r.direct_survive.length).map((r) => `${r.id}[${r.direct_survive.join("|")}]`).join(" ")}`);
  console.log(`[cred/agg]    literal=${cred.filter((r) => r.agg_survive.length).length}/${cred.length}: ${cred.filter((r) => r.agg_survive.length).map((r) => `${r.id}[${r.agg_survive.join("|")}]`).join(" ")}`);
  console.log(`[cred] no token registered: ${cred.filter((r) => r.cred_tokens.length === 0).map((r) => r.id).join(",")}`);
  console.log(`[destr/direct] literal_no_warn=${destr.filter((r) => r.direct_survive.length && !r.direct_warned).length}/${destr.length}: ${destr.filter((r) => r.direct_survive.length && !r.direct_warned).map((r) => `${r.id}[${r.destr_family ?? "-"}/${r.fold_reason ?? "-"}]`).join(" ")}`);
  console.log(`[destr] family null: ${destr.filter((r) => !r.destr_family).map((r) => r.id).join(",")}`);
  const benign = rs.filter((r) => r.cat === "benign");
  const hurt = benign.filter((r) => r.direct_answer.includes("〔"));
  console.log(`[benign/direct] placeholder inserted=${hurt.length}/${benign.length}: ${hurt.map((r) => `${r.id}:${JSON.stringify(r.direct_answer).slice(0, 80)}`).join(" ")}`);
}
