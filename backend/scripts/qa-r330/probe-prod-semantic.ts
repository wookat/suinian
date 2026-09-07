/**
 * 用本地（#369）normalizedGuardedLeak 复扫生产 JSON 里的答案：
 * 找 harness `survive` 没抓到、但按分段列举 / 拼接候选口径应占位的答案。
 * 用法：QA_OUT=<含 blind.json/blind327.json 的目录> npx tsx scripts/qa-r330/probe-prod-semantic.ts <prod-ask-*.json | prod-bypass-mcp-*.json | prod-unmark-*.json>...
 */
import { readFileSync } from "node:fs";
import { normalizedGuardedLeak } from "../../src/prompt-armor";

const OUT = process.env.QA_OUT ?? "scripts/qa-r330/out";
const all = new Map<string, { texts: string[]; needles: string[] }>();
for (const f of ["blind.json", "blind327.json"]) {
  const arr = JSON.parse(readFileSync(`${OUT}/${f}`, "utf8")) as Array<{ id: string; texts: string[]; needles: string[] }>;
  for (const c of arr) all.set(c.id, c);
}

let flagged = 0;
let scanned = 0;
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  for (const [id, rec] of Object.entries(j)) {
    const car = all.get(id);
    if (!car || typeof rec !== "object" || rec === null) continue;
    const r = rec as Record<string, unknown>;
    if (typeof r.answer === "string") {
      scanned++;
      const q = typeof r.q === "string" ? r.q : undefined;
      const hit = normalizedGuardedLeak(r.answer, car.texts, q);
      if (hit) {
        flagged++;
        console.log(`FLAG ${f.split("/").pop()} ${id} mcp/answer kind=${hit}`);
        console.log(`  q=${q}`);
        console.log(`  a=${r.answer.slice(0, 300).replace(/\n/g, " ")}`);
      }
    }
    for (const outlet of ["direct", "agg", "sse", "mcp", "turns", "answers"]) {
      const arr = r[outlet];
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (typeof t !== "object" || t === null) continue;
        const tt = t as Record<string, unknown>;
        const texts: Array<[string, string]> = [];
        if (typeof tt.answer === "string") texts.push(["answer", tt.answer]);
        if (typeof tt.done === "string") texts.push(["done", tt.done]);
        if (typeof tt.emitted === "string") texts.push(["emitted", tt.emitted]);
        if (Array.isArray(tt.notes)) {
          for (const n of tt.notes as Array<Record<string, unknown>>) {
            if (typeof n.content === "string") texts.push(["note", n.content]);
          }
        }
        const q = typeof tt.q === "string" ? tt.q : undefined;
        for (const [kind, text] of texts) {
          scanned++;
          if (kind === "note") continue;
          const hit = normalizedGuardedLeak(text, car.texts, q);
          if (hit) {
            flagged++;
            console.log(`FLAG ${f.split("/").pop()} ${id} ${outlet}/${kind} kind=${hit}`);
            console.log(`  q=${q}`);
            console.log(`  a=${text.slice(0, 300).replace(/\n/g, " ")}`);
          }
        }
      }
    }
  }
}
console.log(`scanned=${scanned} flagged=${flagged}`);
