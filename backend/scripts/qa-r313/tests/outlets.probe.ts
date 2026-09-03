/**
 * R313 非 Ask 聚合出口本地探针：直调线索摘要/标题、周报叙述、Push 摘句、记账标签的收口函数，
 * 输入为「AI 如实复述笔记」的最坏形态 + 只复述短载荷的简答形态，量危险片段存活率（两套语料）。
 * 输出 out/outlets-probe.txt。
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { closeThreadSummary } from "../../../src/threads";
import { closeReportNarrative } from "../../../src/reports";
import { pushSnippet } from "../../../src/push";
import { ledgerLabel } from "../../../src/ask";
import { BLIND } from "../blind-carriers";
import { INFORMED } from "../informed-carriers";

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]): string[] => needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));

type C = { id: string; texts: string[]; needles: string[]; ask: string; set: string };
const ALL: C[] = [
  ...BLIND.map((c) => ({ id: c.id, texts: c.texts, needles: c.needles, ask: c.ask, set: "BLIND" })),
  ...INFORMED.map((c) => ({ id: c.id, texts: c.texts, needles: c.needles, ask: c.ask, set: "INFORMED" })),
];

it("r313 outlets probe", () => {
  mkdirSync("out", { recursive: true });
  const lines: string[] = [];
  const agg: Record<string, { n: number; surv: string[] }> = {};
  const tally = (k: string, id: string, s: string[]) => {
    agg[k] ??= { n: 0, surv: [] };
    agg[k].n++;
    if (s.length) agg[k].surv.push(`${id}[${s.join("|")}]`);
  };
  for (const c of ALL) {
    const rows = c.texts.map((t) => ({ title: null, content: t, meta: null, is_sensitive: 0 }));
    const echo = `这组笔记讲的是：${c.texts.join("；")}。`;
    const terse = `${c.ask.replace(/[？?]/g, "")}：${c.needles.slice(0, 2).join(" ")}。`;
    const title = c.needles[0]?.slice(0, 20) ?? c.texts[0].slice(0, 20);

    const sEcho = closeThreadSummary(echo, rows).summary;
    const sTerse = closeThreadSummary(terse, rows).summary;
    const tTitle = closeThreadSummary(title, rows, { title: true }).verbatimSpans; // 1 = 标题被整体回落
    const rEcho = closeReportNarrative(echo, rows).text;
    const rTerse = closeReportNarrative(terse, rows).text;
    const push = pushSnippet({ title: c.texts[0].slice(0, 40), content: c.texts[0], meta: null } as never, "一条记录", "一条记录");
    const ledger = ledgerLabel({ title: null, content: c.texts[0] });

    const r = {
      thread_summary_echo: hits(sEcho, c.needles),
      thread_summary_terse: hits(sTerse, c.needles),
      thread_title: tTitle === 0 ? hits(title, c.needles) : [],
      report_echo: hits(rEcho, c.needles),
      report_terse: hits(rTerse, c.needles),
      push_title: hits(push.text, c.needles),
      ledger_label: hits(ledger, c.needles),
    };
    for (const [k, v] of Object.entries(r)) tally(`${c.set}/${k}`, c.id, v);
    lines.push(
      `${c.set}/${c.id} ${Object.entries(r).map(([k, v]) => `${k}=${v.length ? v.join("|") : "-"}`).join(" ")}\n    push=${JSON.stringify(push.text)} ledger=${JSON.stringify(ledger)}\n    thread_terse=${sTerse.replace(/\n/g, "⏎")}`
    );
  }
  const summary = Object.entries(agg).map(([k, v]) => `${k}: survive ${v.surv.length}/${v.n} ${v.surv.join(" ")}`);
  writeFileSync("out/outlets-probe.txt", [...summary, "", ...lines].join("\n"));
  console.log(summary.join("\n"));
});
