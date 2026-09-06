// R325 原文出口契约实测：ask 一路闭合之外，MCP `search_notes` 与 REST `GET /api/notes?q=` 是否按「原文契约」把
// 未标敏感的凭证行原样交给调用方（MCP 宿主 / 浏览器）。只量、不评：这是设计上的数据面，但 beta 文案必须如实说明。
// 用法：node prod/search-contract.mjs <label> [ids=BR01,V01,L02]
import { readFileSync, writeFileSync } from "node:fs";
import { req, mcpCall, sleep, OUT, needleHits } from "./lib.mjs";

const [label, idsS = "BR01,BR10,V01,V05,L02,L12"] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8")).filter((c) => acct.notes[c.id]);
const items = corpus.filter((c) => idsS.split(",").includes(c.id));
const T = acct.token;
const rows = {};
const kw = (c) => c.texts[0].replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").find((w) => w.length >= 2 && !needleHits(w, c.needles).length) ?? c.texts[0].slice(0, 4);
for (const c of items) {
  const q = kw(c);
  const rest = await req(`/api/notes?q=${encodeURIComponent(q)}&limit=10`, { token: T });
  const restNotes = rest.json?.notes ?? [];
  const mine = restNotes.filter((n) => acct.notes[c.id].some((v) => v.note_id === n.id));
  const mcp = await mcpCall(T, "search_notes", { query: q, limit: 10 });
  let mcpNotes = [];
  try {
    const env = JSON.parse(mcp.text.replace(/^data:\s*/m, "").split("\n").find((l) => l.trim().startsWith("{")) ?? mcp.text);
    const inner = JSON.parse(env.result?.content?.[0]?.text ?? "{}");
    mcpNotes = inner.notes ?? [];
  } catch {}
  const mcpMine = mcpNotes.filter((n) => acct.notes[c.id].some((v) => v.note_id === n.id));
  rows[c.id] = {
    q,
    rest_status: rest.status,
    rest_recalled: mine.length,
    rest_sensitive: mine.map((n) => n.is_sensitive === true),
    rest_content_raw: mine.map((n) => needleHits(String(n.content ?? ""), c.needles).length > 0),
    mcp_status: mcp.status,
    mcp_recalled: mcpMine.length,
    mcp_content_raw: mcpMine.map((n) => needleHits(String(n.content ?? ""), c.needles).length > 0),
    mcp_raw_text_hit: needleHits(mcp.text, c.needles),
  };
  console.log(c.id, JSON.stringify(rows[c.id]));
  await sleep(1500);
}
writeFileSync(`${OUT}/prod-search-contract-${label}.json`, JSON.stringify(rows, null, 1));
