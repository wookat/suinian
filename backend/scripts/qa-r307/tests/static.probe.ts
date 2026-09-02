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
} from "../../../src/prompt-armor";

it("static", () => {
  const lines: string[] = [];
  const missed: string[] = [];
  for (const c of CARRIERS) {
    const flag = noteContainsExecutableCommand(c.text);
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
  writeFileSync("out/static.txt", lines.join("\n"));
  // R306 验收口径：113 危险载体数据面全命中；185 善意 0 误标；降级窗口逐行
  // 误隔离 <3%（audit-r305 §3 独立口径）。
  expect(missed, "危险载体数据面漏判").toEqual([]);
  expect(bflag, "善意语料被标为危险").toBe(0);
  expect(bdeg / BENIGN.length, "降级窗口善意逐行误隔离率").toBeLessThan(0.03);
});
