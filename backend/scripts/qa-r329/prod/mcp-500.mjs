// R329 未达项复核：MCP ask 偶发 HTTP 500（R328 自报 M05/M06 首跑 500、重跑 200、根因未定位）。
// 只量：对同一账号连续重复 N 次 MCP ask（含 tools/list、search_notes 对照），记录状态码分布、耗时、非 200 的响应体前 300 字。
// 用法：node prod/mcp-500.mjs <label> [rounds=20] [ids=W06,X06,N01]
import { readFileSync, writeFileSync } from "node:fs";
import { mcpCall, sleep, OUT } from "./lib.mjs";

const [label, roundsS = "20", idsS = "W06,X06,N01"] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const items = idsS.split(",").map((id) => corpus.find((c) => c.id === id)).filter(Boolean);
const T = acct.token;
const rows = [];
const RES = `${OUT}/prod-mcp500-${label}.json`;
for (let r = 0; r < Number(roundsS); r++) {
  for (const c of items) {
    const q = c.asks[c.asks.length - 1];
    const t0 = Date.now();
    const m = await mcpCall(T, "ask", { question: q });
    const ms = Date.now() - t0;
    const row = { round: r, id: c.id, tool: "ask", status: m.status, ms, body: m.status === 200 ? null : String(m.text ?? "").slice(0, 300) };
    rows.push(row);
    if (m.status !== 200) console.log(`!! round=${r} ${c.id} status=${m.status} ${ms}ms ${row.body}`);
    await sleep(1500);
  }
  const s = await mcpCall(T, "search_notes", { query: "口令", limit: 5 });
  rows.push({ round: r, id: "-", tool: "search_notes", status: s.status, ms: 0, body: s.status === 200 ? null : String(s.text ?? "").slice(0, 300) });
  writeFileSync(RES, JSON.stringify(rows, null, 1));
  process.stdout.write(`round ${r} done (${rows.filter((x) => x.status !== 200).length} non-200 so far)\n`);
}
const by = {};
for (const x of rows) by[`${x.tool}:${x.status}`] = (by[`${x.tool}:${x.status}`] ?? 0) + 1;
const asks = rows.filter((x) => x.tool === "ask");
const lat = asks.map((x) => x.ms).sort((a, b) => a - b);
console.log(`== mcp-500[${label}] calls=${rows.length} status=${JSON.stringify(by)} ask_p50=${lat[Math.floor(lat.length / 2)]}ms ask_p95=${lat[Math.floor(lat.length * 0.95)]}ms non200=${rows.filter((x) => x.status !== 200).length}`);
