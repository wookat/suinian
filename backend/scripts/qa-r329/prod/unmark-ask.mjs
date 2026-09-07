// R329 取消标记入口 × 出口兜底：W04/W05 载体被数据层标注后，用户本人 PATCH is_sensitive:false 取消标记，
// 再按载体 asks 追问（direct / agg / SSE / MCP ask）——此时数据层标注已被用户撤销，只剩出口逐字兜底：
//   quantify: 取消后原值 / 变形（needles）是否从各出口带出；随后恢复标记（收尾）。
// 用法：node prod/unmark-ask.mjs <label> [ids=W04,W05]
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { req, ask, askStream, mcpCall, parseMcp, sleep, OUT, needleHits, lcsVsSource, PLACE_RE } from "./lib.mjs";

const [label, idsS = "W04,W05"] = process.argv.slice(2);
if (!label) throw new Error("usage: unmark-ask.mjs <label> [ids]");
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const items = idsS.split(",").map((id) => corpus.find((c) => c.id === id)).filter((c) => c && acct.notes[c.id]);
const T = acct.token;
const RES = `${OUT}/prod-unmark-ask-${label}.json`;
const rows = existsSync(RES) ? JSON.parse(readFileSync(RES, "utf8")) : {};
const save = () => writeFileSync(RES, JSON.stringify(rows, null, 1));
const sens = async (id) => { const r = await req(`/api/notes/${id}`, { token: T }); const n = r.json?.note ?? r.json ?? {}; return { status: r.status, sensitive: n.is_sensitive === true, override: n.manual_override ?? n.meta?.manual_override ?? null, content: String(n.content ?? "") }; };

for (const c of items) {
  if (rows[c.id]?.done) continue;
  const R = (rows[c.id] ??= { family: c.family, seam: c.seam ?? null });
  const ids = acct.notes[c.id].map((v) => v.note_id).filter(Boolean);
  R.before = [];
  for (const id of ids) R.before.push(await sens(id));
  // 取消标记（本人）
  R.unmark = [];
  for (const id of ids) {
    const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { is_sensitive: false } });
    const pn = p.json?.note ?? p.json ?? {};
    R.unmark.push({ status: p.status, sensitive: pn.is_sensitive === true, content_raw: needleHits(String(pn.content ?? ""), c.needles).length > 0 });
    await sleep(1200);
  }
  save();
  // 追问：direct / agg（多轮带历史）
  for (const tier of ["direct", "agg"]) {
    const hist = [];
    const turns = [];
    let self = "";
    for (const q of c.asks) {
      self += "\n" + q;
      const r = await ask(T, q, { tier, history: hist.length ? [...hist] : undefined });
      const ans = r.json?.answer ?? "";
      turns.push({ q, status: r.status, answer: ans, survive: needleHits(ans, c.needles), lcs: lcsVsSource(ans, c.texts, self), placeholders: (ans.match(PLACE_RE) ?? []).length, trust_tier: r.json?.trust_tier ?? null, refs_n: (r.json?.notes ?? r.json?.references ?? []).length });
      hist.push({ role: "user", content: q }, { role: "assistant", content: ans });
      self += "\n" + ans;
      await sleep(4200);
    }
    R[tier] = turns;
    save();
  }
  // SSE + MCP（首问）
  {
    const s = await askStream(T, c.asks[0]);
    R.sse = { status: s.status, deltas: s.deltas, emitted_survive: needleHits(s.emitted, c.needles), done_survive: needleHits(s.done?.answer ?? "", c.needles), done_notes_raw: needleHits(JSON.stringify(s.done?.notes ?? s.done?.references ?? []), c.needles) };
    await sleep(4200);
    const m = await mcpCall(T, "ask", { question: c.asks[0] });
    const mb = parseMcp(m.text) ?? {};
    R.mcp = { status: m.status, answer: mb.answer ?? "", answer_survive: needleHits(mb.answer ?? "", c.needles), notes_raw: needleHits(JSON.stringify(mb.notes ?? []), c.needles), raw_survive: needleHits(m.text, c.needles.filter((n) => n.length >= 4)) };
    await sleep(4200);
  }
  // 收尾：恢复标记
  R.remark = [];
  for (const id of ids) {
    const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { is_sensitive: true } });
    R.remark.push({ status: p.status, sensitive: (p.json?.note ?? p.json ?? {}).is_sensitive === true });
    await sleep(1200);
  }
  R.done = true;
  save();
  const surv = (arr) => arr.flatMap((t) => t.survive);
  console.log(`${c.id} before_sensitive=${R.before.map((b) => b.sensitive).join("/")} unmark=${R.unmark.map((u) => `${u.status}:${u.sensitive}:raw=${u.content_raw}`).join(",")} direct_survive=[${surv(R.direct).join("|")}] agg_survive=[${surv(R.agg).join("|")}] sse=${R.sse.emitted_survive.length}/${R.sse.done_survive.length}/${R.sse.done_notes_raw.length} mcp=${R.mcp.answer_survive.length}/${R.mcp.notes_raw.length}/${R.mcp.raw_survive.length}\n   direct: ${JSON.stringify(R.direct.map((t) => t.answer.slice(0, 100)))}\n   agg: ${JSON.stringify(R.agg.map((t) => t.answer.slice(0, 100)))}`);
}
