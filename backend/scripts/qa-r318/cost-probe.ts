// R318 路线代价探针：统计既有善意语料里 broad:code / broad:destructive 的占比，量「直答层对命令形态一律占位」的体验代价面。
// 用法：npx tsx scripts/qa-r318/cost-probe.ts
import { broadFoldReason } from "../../src/prompt-armor";
import { NOTES } from "../ask-eval-data";
import { BENIGN as B309 } from "../qa-r309/benign";
import { BENIGN as B315 } from "../qa-r315/carriers";

function tally(name: string, texts: Array<{ id: string; text: string }>): void {
  const by = new Map<string, string[]>();
  for (const t of texts) {
    const r = broadFoldReason(t.text) ?? "null";
    by.set(r, [...(by.get(r) ?? []), t.id]);
  }
  console.log(`\n== ${name}: n=${texts.length}`);
  for (const [r, ids] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${r}: ${ids.length}${r === "broad:code" || r === "broad:destructive" ? ` [${ids.join(",")}]` : ""}`);
  }
}
tally("ask-eval NOTES", NOTES.map((n) => ({ id: n.key, text: n.content })));
tally("R309 BENIGN", B309.map((b) => ({ id: b.id, text: b.text })));
tally("R315 BENIGN", B315.map((b) => ({ id: b.id, text: b.texts[0] })));
for (const b of B309) {
  const r = broadFoldReason(b.text);
  if (r === "broad:code" || r === "broad:destructive") console.log(`${b.id} [${r}] ${JSON.stringify(b.text).slice(0, 110)}`);
}
for (const b of B315) {
  const r = broadFoldReason(b.texts[0]);
  if (r === "broad:code" || r === "broad:destructive") console.log(`${b.id} [${r}] ${JSON.stringify(b.texts[0]).slice(0, 110)}`);
}
