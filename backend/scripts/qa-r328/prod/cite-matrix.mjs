// R328 引用归因矩阵（audit-r327 §5.3 同口径）：读 prod/ask.mjs 的结果，逐题核对引用卡身份。
//   exact = 引用卡全部是本载体自己的条；mixed = 有自己的也有别的载体的；wrong = 有引用但没有一张是自己的；none = 0 引用。
// 用法：node prod/cite-matrix.mjs <label> [modes=direct,agg]
import { readFileSync } from "node:fs";
import { OUT } from "./lib.mjs";

const [label, modesS] = process.argv.slice(2);
if (!label) throw new Error("usage: cite-matrix.mjs <label> [modes]");
const modes = (modesS ?? "direct,agg").split(",");
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${OUT}/prod-ask-${label}.json`, "utf8"));
const owner = new Map();
for (const [cid, vs] of Object.entries(acct.notes)) for (const v of vs) if (v.note_id) owner.set(v.note_id, cid);

for (const mode of modes) {
  const tally = { exact: 0, mixed: 0, wrong: 0, none: 0 };
  const detail = { mixed: [], wrong: [] };
  let n = 0;
  for (const [cid, R] of Object.entries(rows)) {
    const turns = Array.isArray(R[mode]) ? R[mode] : [];
    turns.forEach((r, ti) => {
      if (r.status !== 200) return;
      // 多轮载体只算最后一轮（前几轮是铺垫）；S05 两态各算一题
      if (turns.length > 1 && ti < turns.length - 1 && !R.seam) return;
      const ids = r.ref_ids ?? [];
      n++;
      const mine = ids.filter((id) => owner.get(id) === cid).length;
      const others = ids.filter((id) => owner.get(id) !== cid).map((id) => owner.get(id) ?? "?");
      const cls = !ids.length ? "none" : mine === ids.length ? "exact" : mine > 0 ? "mixed" : "wrong";
      tally[cls]++;
      if (cls === "mixed" || cls === "wrong") detail[cls].push(`${cid}#${ti}(${mine}/${ids.length}:${[...new Set(others)].join("+")})`);
    });
  }
  console.log(`${mode}: n=${n} exact=${tally.exact} mixed=${tally.mixed} wrong=${tally.wrong} none=${tally.none}`);
  if (detail.wrong.length) console.log("  wrong:", detail.wrong.join(" "));
  if (detail.mixed.length) console.log("  mixed:", detail.mixed.join(" "));
}
