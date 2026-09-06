/**
 * R326 本地校准表（decision-r326 §4）：对 R325 全部载体（V/L/Q/B/BR/I）跑当前分支的确定性判据
 *   detect = detectSensitive（定论规则：命中即强制 is_sensitive=true，模型判非敏感也不放行）
 *   maybe  = maybeSensitive（宽判据：fail-closed 先加密 + needs_retriage，等模型复判）
 * 输出两张表：危险载体的规则覆盖（漏 = 只能靠模型标注），善意载体的规则误标（maybe 命中 = 多点一次卡片的成本，
 * detect 命中 = 无法被模型纠正的硬误标）。校准前后的对比：在 main 与本分支各跑一次即可（语料不动）。
 * 用法：npx tsx scripts/qa-r326/calibration.ts [--json]
 */
import { V, L, B, Q } from "../qa-r325/blind-carriers";
import { INFORMED } from "../qa-r325/informed-carriers";
import { detectSensitive, maybeSensitive } from "../../src/triage";

type Row = { id: string; family: string; texts: string[]; cat: "danger" | "benign" };
const qRows: Row[] = Q.map((q) => ({ id: q.id, family: q.family, texts: [q.text], cat: "danger" }));
const items: Row[] = [...V, ...L, ...qRows, ...INFORMED, ...B];

interface Verdict {
  id: string;
  family: string;
  cat: "danger" | "benign";
  detect: boolean;
  maybe: boolean;
}
const rows: Verdict[] = items.map((c) => ({
  id: c.id,
  family: c.family,
  cat: c.cat,
  detect: c.texts.some((t) => detectSensitive(t)),
  maybe: c.texts.some((t) => maybeSensitive(t)),
}));

const danger = rows.filter((r) => r.cat === "danger");
const benign = rows.filter((r) => r.cat === "benign");
const retrieve = benign.filter((r) => r.id.startsWith("BR"));
const summary = {
  danger: { n: danger.length, detect: danger.filter((r) => r.detect).length, maybe: danger.filter((r) => r.maybe).length, rule_miss: danger.filter((r) => !r.maybe).map((r) => r.id) },
  benign: { n: benign.length, detect: benign.filter((r) => r.detect).map((r) => r.id), maybe: benign.filter((r) => r.maybe).map((r) => r.id) },
  benign_retrieve: { n: retrieve.length, detect: retrieve.filter((r) => r.detect).map((r) => r.id), maybe: retrieve.filter((r) => r.maybe).map((r) => r.id) },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ rows, summary }, null, 2));
} else {
  console.log("id\tcat\tdetect\tmaybe\tfamily");
  for (const r of rows) console.log(`${r.id}\t${r.cat}\t${r.detect ? "Y" : "-"}\t${r.maybe ? "Y" : "-"}\t${r.family}`);
  console.log("");
  console.log(`danger n=${summary.danger.n} detect=${summary.danger.detect} maybe=${summary.danger.maybe} rule_miss(需模型标注)=${summary.danger.rule_miss.join(",") || "-"}`);
  console.log(`benign n=${summary.benign.n} detect(硬误标)=${summary.benign.detect.join(",") || "-"} maybe(预检误标,待模型纠正)=${summary.benign.maybe.join(",") || "-"}`);
  console.log(`benign-retrieve(BR) n=${summary.benign_retrieve.n} detect=${summary.benign_retrieve.detect.join(",") || "-"} maybe=${summary.benign_retrieve.maybe.join(",") || "-"}`);
}
