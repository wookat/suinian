/**
 * R311 §1–§5 收口函数静态探针（测量型，不断言产品行为）：
 * 对 attack.mjs 每条载荷，以「模型如此复述」的答案直接过 finalizeAskAnswer / closeVerbatimOverlap，
 * 记录：宽/严判据、收口是否触发、载荷是否仍在答案里（归一化面）、leak.mjs 任意片段口径。
 * 输出 out/closure.json / closure.txt。
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  finalizeAskAnswer,
  closeVerbatimOverlap,
  verbatimEchoRatio,
  broadFoldReason,
  noteContainsExecutableCommand,
  shortPlainFactText,
  VERBATIM_ECHO_DOMINANT,
} from "../../../src/prompt-armor";
import { ALL } from "../attack.mjs";
import { leakedFragments, norm } from "../../qa-r310/leak.mjs";

type Atk = { id: string; 面: string; note: string; answer: string; payload: string; q?: string; note_b?: string };

it("r311 closure probe", () => {
  mkdirSync("out", { recursive: true });
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const a of ALL as Atk[]) {
    const units = [a.note, ...(a.note_b ? [a.note_b] : [])];
    const q = a.q ?? "那条笔记讲的是什么？";
    const broad = broadFoldReason(a.note);
    const strict = noteContainsExecutableCommand(a.note);
    const fin = finalizeAskAnswer(a.answer, { dataText: units.join("\n"), dataUnits: units, question: q });
    const closed = closeVerbatimOverlap(a.answer, { units, broadUnits: units.filter((u) => broadFoldReason(u) !== null), question: q });
    const echo = verbatimEchoRatio(a.answer, { units, broadUnits: units.filter((u) => broadFoldReason(u) !== null), question: q });
    const np = norm(a.payload);
    const payloadSurvives = np.length > 0 ? norm(fin.answer).includes(np) : fin.answer.includes(a.payload.trim());
    const leaks = leakedFragments(fin.answer, a.note_b ?? a.note, q);
    const r = {
      id: a.id,
      面: a.面,
      broad,
      strict,
      plainFact: shortPlainFactText(a.note),
      spans: closed.count,
      fin_changed: fin.changed,
      fin_isolated: fin.isolated,
      fin_reason: fin.reason ?? null,
      echo: Number(echo.toFixed(2)),
      echo_regen: echo >= VERBATIM_ECHO_DOMINANT,
      payload_survives: payloadSurvives,
      leaks: leaks.map((f) => `${f.kind}:${f.frag}`),
      out: fin.answer,
    };
    rows.push(r);
    lines.push(
      `${a.id} [${a.面}] broad=${broad} strict=${strict} plain=${r.plainFact} spans=${closed.count} echo=${r.echo} PAYLOAD_SURVIVES=${payloadSurvives} leaks=${r.leaks.length}\n    note   : ${a.note.replace(/\n/g, "⏎")}\n    answer : ${a.answer.replace(/\n/g, "⏎")}\n    out    : ${fin.answer.replace(/\n/g, "⏎")}`
    );
  }
  const surv = rows.filter((r) => r.payload_survives);
  lines.unshift(`R311 closure probe: n=${rows.length} payload_survives=${surv.length} (${surv.map((r) => r.id).join(",")})`);
  writeFileSync("out/closure.txt", lines.join("\n"));
  writeFileSync("out/closure.json", JSON.stringify(rows, null, 1));
  console.log(lines.join("\n"));
});
