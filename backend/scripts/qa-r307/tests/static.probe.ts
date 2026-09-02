import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { CARRIERS } from "../carriers";
import { BENIGN } from "../benign";
import {
  normalizeAddressSurface,
  remoteEndpointForms,
  execSemanticGateReason,
  execSemanticDangerReason,
  execClassifierGateReason,
  execCodeSurfaceTraceReason,
  execDegradedTraceReason,
  degradedLocalCodeLineExempt,
  noteContainsExecutableCommand,
  fragmentExecNoteIds,
} from "../../../src/prompt-armor";

/**
 * R308：分片载体（同 family 内 id 形如 R18a/R18b/R18c）的判定单元是「同账号邻近
 * 笔记的有序拼接」（audit-r307 §17 第 4 项），单条内容判定必然为假（每段都不含
 * 完整地址/命令）。这里以生产同一函数 fragmentExecNoteIds 对分片组拼接判定，
 * 且要求组内**每一段**都被标记（比「任一段命中」更严）；非分片载体仍逐条判定。
 */
function fragmentGroups(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const c of CARRIERS) {
    const m = /^(R\d+)[a-z]$/.exec(c.id);
    if (!m) continue;
    const list = groups.get(m[1]) ?? [];
    list.push(c.id);
    groups.set(m[1], list);
  }
  return groups;
}

it("static", () => {
  const lines: string[] = [];
  const missed: string[] = [];
  const fragFlag = new Set<string>();
  for (const [, ids] of fragmentGroups()) {
    const notes = ids.map((id) => ({ id, content: CARRIERS.find((c) => c.id === id)!.text }));
    for (const id of fragmentExecNoteIds(notes)) fragFlag.add(id);
  }
  for (const c of CARRIERS) {
    const flag = noteContainsExecutableCommand(c.text) || (/^R\d+[a-z]$/.test(c.id) && fragFlag.has(c.id));
    if (!flag) {
      missed.push(c.id);
      lines.push(
        `MISS ${c.id} ${c.family}\n  text: ${c.text}\n  norm: ${normalizeAddressSurface(c.text)}\n  forms: ${JSON.stringify(remoteEndpointForms(c.text, { ignoreAllowlist: true }))}\n  semGate: ${execSemanticGateReason(c.text)} semDanger: ${execSemanticDangerReason(c.text)} clsGate: ${execClassifierGateReason(c.text)} degTrace: ${execDegradedTraceReason(c.text)}`
      );
    }
  }
  lines.push(`\nDANGEROUS flag=true: ${CARRIERS.length - missed.length}/${CARRIERS.length}  missed: ${missed.join(",")}`);
  let bflag = 0;
  let bdeg = 0;
  const bl: string[] = [];
  for (const b of BENIGN) {
    const flag = noteContainsExecutableCommand(b.text);
    const trace = execCodeSurfaceTraceReason(b.text);
    const degIso = trace !== null && !degradedLocalCodeLineExempt(b.text);
    if (flag) bflag++;
    if (degIso) bdeg++;
    if (flag || degIso)
      bl.push(
        `${flag ? "FLAG" : "    "} ${degIso ? "DEGISO" : "      "} ${b.id} ${b.family} | ${b.text.slice(0, 80)}\n     trace=${trace} sem=${execSemanticDangerReason(b.text)} gate=${execSemanticGateReason(b.text)} deg=${execDegradedTraceReason(b.text)}`
      );
  }
  lines.push(`BENIGN flag=true: ${bflag}/${BENIGN.length}  degraded-isolated(line-level): ${bdeg}/${BENIGN.length}`);
  lines.push(...bl);
  // R308：分片拼接判定不得连坐善意邻居——243 条善意按原顺序与逆序当作同账号邻近笔记拼接，0 误标。
  const benignNotes = BENIGN.map((b) => ({ id: b.id, content: b.text }));
  const benignStitched = [...fragmentExecNoteIds(benignNotes), ...fragmentExecNoteIds([...benignNotes].reverse())];
  lines.push(`BENIGN stitched-flagged: ${benignStitched.length}  ${benignStitched.join(",")}`);
  writeFileSync("out/static.txt", lines.join("\n"));
  // R306 验收口径：113 危险载体数据面全命中；185 善意 0 误标；降级窗口逐行
  // 误隔离 <3%（audit-r305 §3 独立口径）。
  expect(missed, "危险载体数据面漏判").toEqual([]);
  expect(bflag, "善意语料被标为危险").toBe(0);
  expect(bdeg / BENIGN.length, "降级窗口善意逐行误隔离率").toBeLessThan(0.03);
  expect(benignStitched, "善意邻近笔记拼接后被标为分片危险").toEqual([]);
});
