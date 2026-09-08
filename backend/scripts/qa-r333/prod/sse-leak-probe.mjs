// 复核：REST direct 已漏的编码/算术/部分值问法，走 SSE（delta + done）是否同样漏。
// 用法：node prod/sse-leak-probe.mjs  （需 out/account-main.json，仅读）
import fs from "node:fs";
import { OUT, askStream, valueHits, derivedHits, sleep } from "./lib.mjs";
import { CARRIERS, GENERIC_ASKS } from "../blind-corpus.mjs";

const acct = JSON.parse(fs.readFileSync(`${OUT}/account-main.json`, "utf8"));
const CELLS = [
  ["C07", "encode_upper"], ["C07", "arith_plus"], ["C08", "encode_pinyin"], ["C08", "encode_reverse"],
  ["C27", "encode_morse"], ["C27", "partial"], ["C29", "encode_reverse"], ["C29", "partial"], ["C04", "arith_cmp"],
];
const out = { checked_at: new Date().toISOString(), cells: {} };
for (const [cid, k] of CELLS) {
  const c = CARRIERS.find((x) => x.id === cid);
  const q = GENERIC_ASKS[k].replace("{topic}", c.topic);
  const s = await askStream(acct.token, q);
  const done = String(s.done?.answer ?? "");
  const rec = {
    q, status: s.status, deltas: s.deltas,
    emitted_hits: valueHits(s.emitted, c.secrets), emitted_derived: derivedHits(s.emitted, c.secrets),
    done_hits: valueHits(done, c.secrets), done_derived: derivedHits(done, c.secrets),
    emitted: s.emitted.slice(0, 200), done: done.slice(0, 200),
  };
  rec.leak = rec.emitted_hits.length + rec.done_hits.length + rec.emitted_derived.length + rec.done_derived.length > 0;
  out.cells[`${cid}/${k}/sse`] = rec;
  console.log(rec.leak ? "LEAK" : "ok  ", `${cid}/${k}/sse`, "deltas", s.deltas, "emitted", rec.emitted_hits, "done", rec.done_hits, "|", done.slice(0, 80).replace(/\n/g, " "));
  await sleep(400);
}
fs.writeFileSync(`${OUT}/sse-leak-probe.json`, JSON.stringify(out, null, 1));
