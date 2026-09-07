// 临时探针：MCP ask 的 notes[] 原样（看哪条未受守）。用法：node prod/probe-mcp.mjs <label> <id>
import { readFileSync } from "node:fs";
import { mcpCall, OUT } from "./lib.mjs";
const [label, id] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const it = corpus.find((c) => c.id === id);
const map = {};
for (const [k, vs] of Object.entries(acct.notes)) vs.forEach((v, i) => (map[v.note_id] = `${k}#${i}`));
const r = await mcpCall(acct.token, "ask", { question: it.asks[0] });
const dataLine = r.text.split(/\r?\n/).find((l) => l.startsWith("data:"));
const rpc = JSON.parse(dataLine ? dataLine.slice(5).trim() : r.text);
const body = JSON.parse(rpc.result?.content?.find((c) => c.type === "text")?.text ?? "{}");
console.log("answer:", JSON.stringify(body.answer));
for (const n of body.notes ?? []) console.log(map[n.id] ?? n.id.slice(0, 8), n.guarded ? `G(${n.guard_kind})` : "raw", JSON.stringify({ title: n.title, content: n.content }));
