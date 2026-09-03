/**
 * R310 宽判据静态探针（测量工具，不断言）：
 *  - 危险 215（R307 145 + R309 70）逐条：严判据 / 宽判据 / 折叠（宽 ∪ 分片邻近拼接）
 *  - 善意 307（R307 243 + R309 64）逐条：宽判据命中即「多折叠一次」，与 audit-r309 §4.2 的 ~30 条对照
 *  - 全部数字写 out/r310-broad.json / .txt
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS, NEW309 } from "../../qa-r309/carriers";
import { BENIGN } from "../../qa-r309/benign";
import { broadFoldReason, noteContainsExecutableCommand, fragmentExecNoteIds } from "../../../src/prompt-armor";

const FRAG_ID_RE = /^([A-Z]+\d+)[a-z]$/;

it("r310 broad fold", () => {
  mkdirSync("out", { recursive: true });
  const groups = new Map<string, string[]>();
  for (const c of CARRIERS) {
    const m = FRAG_ID_RE.exec(c.id);
    if (m) groups.set(m[1], [...(groups.get(m[1]) ?? []), c.id]);
  }
  const fragFlag = new Set<string>();
  for (const [, ids] of groups) {
    if (ids.length < 2) continue;
    const notes = ids.map((id) => ({ id, content: CARRIERS.find((c) => c.id === id)!.text }));
    for (const id of fragmentExecNoteIds(notes)) fragFlag.add(id);
  }
  const rows = CARRIERS.map((c) => {
    const strict = noteContainsExecutableCommand(c.text);
    const broad = broadFoldReason(c.text);
    return { id: c.id, cat: c.cat, family: c.family, strict, broad, frag: fragFlag.has(c.id), fold: broad !== null || fragFlag.has(c.id) };
  });
  const lines: string[] = [];
  for (const cat of ["reg", "new"] as const) {
    const rs = rows.filter((r) => r.cat === cat);
    const strictMiss = rs.filter((r) => !r.strict && !r.frag);
    const foldMiss = rs.filter((r) => !r.fold);
    lines.push(
      `[${cat}] 危险 ${rs.length}：严判据漏 ${strictMiss.length}；宽判据/折叠漏 ${foldMiss.length} → ${foldMiss.map((r) => `${r.id}(${r.family})`).join(", ")}`
    );
    const diff = rs.filter((r) => !r.strict && !r.frag && r.fold);
    lines.push(`   宽命中但严未命中（漏判可观测代理）：${diff.length} → ${diff.map((r) => `${r.id}:${r.broad}`).join(", ")}`);
  }
  for (const r of rows.filter((x) => !x.fold)) lines.push(`MISS ${r.id} ${r.family}: ${CARRIERS.find((c) => c.id === r.id)!.text}`);
  const brows = BENIGN.map((b) => ({ id: b.id, cat: b.cat ?? "reg", family: b.family, strict: noteContainsExecutableCommand(b.text), broad: broadFoldReason(b.text), text: b.text }));
  lines.push("\n--- 善意 ---");
  for (const cat of ["reg", "new"] as const) {
    const rs = brows.filter((r) => r.cat === cat);
    const f = rs.filter((r) => r.broad !== null);
    lines.push(`[${cat}] 善意 ${rs.length}：宽判据折叠 ${f.length} (${((f.length / rs.length) * 100).toFixed(1)}%)`);
    for (const r of f) lines.push(`  FOLD ${r.id} ${r.broad} :: ${r.text.slice(0, 80).replace(/\n/g, "⏎")}`);
  }
  writeFileSync("out/r310-broad.txt", lines.join("\n"));
  writeFileSync(
    "out/r310-broad.json",
    JSON.stringify({ generated: new Date().toISOString(), carriers: rows, new309: NEW309.length, benign: brows.map(({ text: _t, ...r }) => r) }, null, 1)
  );
  console.log(lines.join("\n"));
});
