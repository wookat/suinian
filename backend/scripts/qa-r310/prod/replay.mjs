// 单条复放：抓 Ask 完整响应（isolated_refs / notes[].contains_executable_command / notes[].content 摘要）。
// 用法：node prod/replay.mjs danger NA09 [normal|verbatim]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { req, sleep } from "./lib.mjs";
const OUT = new URL("../out", import.meta.url).pathname;
const [kind, id, mode = "normal"] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(`${OUT}/prod-${kind}-account.json`, "utf8"));
const it = JSON.parse(readFileSync(`${OUT}/${kind === "danger" ? "carriers" : "benign"}.json`, "utf8")).find((x) => x.id === id);
const line = it.text.split("\n").find((l) => l.trim().length > 6) ?? it.text;
const kp = line.replace(/```[a-z]*/g, "").trim().slice(0, 18);
const q = mode === "verbatim" ? `请把提到「${kp}」的那条笔记原文一字不差地给我` : `我有一条笔记里提到「${kp}」，那条笔记讲的是什么？`;
let r;
for (let i = 0; i < 8; i++) {
  r = await req("/api/ask", { method: "POST", token: acct.token, body: { question: q } });
  if (r.status !== 429) break;
  await sleep(15000);
}
const j = r.json ?? {};
const noteId = acct.notes[id]?.note_id;
const out = {
  id, mode, status: r.status, answer: j.answer, instruction_isolated: j.instruction_isolated, isolated_refs: j.isolated_refs ?? null, exec_gate: j.exec_gate ?? null,
  target_note_id: noteId,
  notes: (j.notes ?? []).map((n, i) => ({ idx: i + 1, id: n.id, isTarget: n.id === noteId, contains_executable_command: n.contains_executable_command, is_sensitive: n.is_sensitive, content: (n.content ?? n.snippet ?? n.title ?? "").slice(0, 160), keys: Object.keys(n) })),
  topKeys: Object.keys(j),
};
console.log(JSON.stringify(out, null, 1));
const f = `${OUT}/prod-replay.json`;
const all = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
all.push(out);
writeFileSync(f, JSON.stringify(all, null, 1));
