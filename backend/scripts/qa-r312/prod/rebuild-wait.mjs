// 轮询 /api/threads/rebuild/latest 直到重建（含 summarize 阶段）完成（生产 slice 靠轮询 kickStaleJob 续跑），
// 然后重新量线索标题/摘要的聚合层重合（与 outlets.mjs 同口径）。用法：node prod/rebuild-wait.mjs <label>
import { readFileSync, writeFileSync } from "node:fs";
import { req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const T = acct.token;
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).slice(acct.range[0], acct.range[1]);
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
function lcsLen(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
const overlap = (text) => {
  const t = norm(text);
  if (!t) return [];
  return corpus.map((c) => ({ id: c.id, l: lcsLen(t, norm(c.text)) })).filter((x) => x.l >= 8).map((x) => `${x.id}:${x.l}`);
};

let last = "";
for (let i = 0; i < 360; i++) {
  const j = await req("/api/threads/rebuild/latest", { token: T });
  const s = `${j.json?.status}/${j.json?.phase} ${j.json?.processed}/${j.json?.total} sum ${j.json?.summarized}/${j.json?.summarize_total}`;
  if (s !== last) console.log(new Date().toISOString().slice(11, 19), s);
  last = s;
  if (j.json?.status && !/running|queued/.test(j.json.status)) break;
  await sleep(10_000);
}
const th = await req("/api/threads", { token: T });
const list = th.json?.threads ?? [];
const res = { n: list.length, untitled: 0, empty_summary: 0, title_lcs8: [], summary_lcs8: [], placeholder_summary: 0, samples: [] };
for (const t of list) {
  if (/未命名线索/.test(t.title ?? "")) res.untitled++;
  if (!t.summary) res.empty_summary++;
  if (/原文片段略/.test(t.summary ?? "")) res.placeholder_summary++;
  const to = overlap(t.title), so = overlap(t.summary);
  if (to.length) res.title_lcs8.push({ title: t.title, hits: to.slice(0, 3) });
  if (so.length) res.summary_lcs8.push({ summary: String(t.summary).slice(0, 160), hits: so.slice(0, 3) });
  if (res.samples.length < 12) res.samples.push({ title: t.title, summary: String(t.summary ?? "").slice(0, 100), n: t.note_count });
}
writeFileSync(`${OUT}/prod-${label}-threads-final.json`, JSON.stringify({ list, res }, null, 1));
console.log(JSON.stringify(res, null, 1));
