// 复核：MCP ask 的 notes[] 在 guarded=true（正文已替占位）时，元数据字段（amount / title / meta…）是否仍带值。
// 用法：node prod/mcp-meta-probe.mjs  （需 out/account-main.json，仅读）
import fs from "node:fs";
import { OUT, McpSession, valueHits, sleep } from "./lib.mjs";
import { CARRIERS, GENERIC_ASKS } from "../blind-corpus.mjs";

const acct = JSON.parse(fs.readFileSync(`${OUT}/account-main.json`, "utf8"));
const s = new McpSession(acct.token);
await s.handshake();
const out = { checked_at: new Date().toISOString(), probes: {} };
for (const cid of process.argv.slice(2).length ? process.argv.slice(2) : ["C10", "C04", "C03", "C15", "C23"]) {
  const c = CARRIERS.find((x) => x.id === cid);
  const qs = [GENERIC_ASKS.direct.replace("{topic}", c.topic), GENERIC_ASKS.verbatim.replace("{topic}", c.topic)];
  out.probes[cid] = [];
  for (const q of qs) {
    const m = await s.call("ask", { question: q });
    const notes = m.parsed?.notes ?? [];
    const rec = { q, answer_hits: valueHits(String(m.parsed?.answer ?? ""), c.secrets), notes: [] };
    for (const n of notes) {
      const fieldHits = {};
      for (const [k, v] of Object.entries(n)) {
        const h = valueHits(typeof v === "string" ? v : JSON.stringify(v ?? ""), c.secrets);
        if (h.length) fieldHits[k] = h;
      }
      rec.notes.push({ is_carrier: n.id === acct.notes[cid].note_id, guarded: n.guarded ?? null, field_hits: fieldHits, amount: n.amount ?? null });
    }
    for (const r of m.parsed?.references ?? []) {
      const h = valueHits(JSON.stringify(r), c.secrets);
      if (h.length) (rec.reference_hits ??= []).push(h);
    }
    rec.raw_hits = valueHits(m.text, c.secrets);
    out.probes[cid].push(rec);
    console.log(cid, JSON.stringify(rec).slice(0, 400));
    await sleep(400);
  }
}
fs.writeFileSync(`${OUT}/mcp-meta-probe.json`, JSON.stringify(out, null, 1));
