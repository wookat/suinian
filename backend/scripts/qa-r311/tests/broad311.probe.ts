/**
 * R311 §7 宽判据泛化 + §1 长度门限扫描（测量型）：
 *  - 复测 R307 145 + R309 70 危险 / 善意 307（与 R310 自报对照）
 *  - 新造 44 纯语义载体 + 42 善意：宽判据折叠率、严判据命中率、shortPlainFactText 例外命中率、
 *    以及「模型整段复述时 closeVerbatimOverlap 是否触发」（answer = note 原文）
 *  - 长度扫描：不含任何代码字符的纯文字笔记，长度从 4 到 60 折叠字，整段复述何时开始被收口
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { CARRIERS } from "../../qa-r309/carriers";
import { BENIGN } from "../../qa-r309/benign";
import { NEW311, BENIGN311 } from "../new-carriers.mjs";
import { broadFoldReason, noteContainsExecutableCommand, shortPlainFactText, closeVerbatimOverlap } from "../../../src/prompt-armor";

type C = { id: string; family: string; text: string };

function echoClosed(text: string): { spans: number; survives: boolean } {
  const units = [text];
  const broadUnits = broadFoldReason(text) !== null ? units : [];
  const r = closeVerbatimOverlap(text, { units, broadUnits, question: "那条笔记讲的是什么？" });
  return { spans: r.count, survives: r.count === 0 };
}

it("r311 broad generalization + length sweep", () => {
  mkdirSync("out", { recursive: true });
  const lines: string[] = [];
  const cRows = CARRIERS.map((c) => ({ id: c.id, cat: c.cat, broad: broadFoldReason(c.text), strict: noteContainsExecutableCommand(c.text), echo: echoClosed(c.text) }));
  for (const cat of ["reg", "new"] as const) {
    const rs = cRows.filter((r) => r.cat === cat);
    lines.push(`[R310 复测/${cat}] 危险 ${rs.length}: 严判据漏 ${rs.filter((r) => !r.strict).length}, 宽判据漏 ${rs.filter((r) => r.broad === null).length} → ${rs.filter((r) => r.broad === null).map((r) => r.id).join(",")}; 整段复述未收口 ${rs.filter((r) => r.echo.survives).length} → ${rs.filter((r) => r.echo.survives).map((r) => r.id).join(",")}`);
  }
  const bRows = BENIGN.map((b) => ({ id: b.id, cat: b.cat ?? "reg", broad: broadFoldReason(b.text) }));
  lines.push(`[R310 复测] 善意 ${bRows.length}: 宽判据折叠 ${bRows.filter((r) => r.broad !== null).length} (${((100 * bRows.filter((r) => r.broad !== null).length) / bRows.length).toFixed(1)}%)`);

  const nRows = (NEW311 as C[]).map((c) => ({ ...c, broad: broadFoldReason(c.text), strict: noteContainsExecutableCommand(c.text), plain: shortPlainFactText(c.text), echo: echoClosed(c.text) }));
  const nFold = nRows.filter((r) => r.broad !== null);
  const nEchoSurv = nRows.filter((r) => r.echo.survives);
  lines.push(`\n[R311 新造危险] n=${nRows.length}: 严判据命中 ${nRows.filter((r) => r.strict).length}, 宽判据折叠 ${nFold.length} (${((100 * nFold.length) / nRows.length).toFixed(1)}%), 未折叠 ${nRows.length - nFold.length}; shortPlainFact 例外 ${nRows.filter((r) => r.plain).length}; 整段复述未收口 ${nEchoSurv.length} (${((100 * nEchoSurv.length) / nRows.length).toFixed(1)}%)`);
  for (const r of nRows) lines.push(`  ${r.id} ${r.family.padEnd(14)} broad=${String(r.broad).padEnd(16)} strict=${r.strict} plain=${r.plain} echoSpans=${r.echo.spans} ${r.echo.survives ? "ECHO_SURVIVES" : ""} :: ${r.text.replace(/\n/g, "⏎")}`);

  const bnRows = (BENIGN311 as C[]).map((c) => ({ ...c, broad: broadFoldReason(c.text), strict: noteContainsExecutableCommand(c.text), echo: echoClosed(c.text) }));
  lines.push(`\n[R311 新造善意] n=${bnRows.length}: 宽判据折叠 ${bnRows.filter((r) => r.broad !== null).length}, 严判据 ${bnRows.filter((r) => r.strict).length}, 整段复述被收口 ${bnRows.filter((r) => !r.echo.survives).length}`);
  for (const r of bnRows.filter((r) => r.broad !== null || r.strict)) lines.push(`  FOLD ${r.id} ${r.broad} strict=${r.strict} :: ${r.text}`);

  // 长度扫描：纯中文叙述（无 ASCII 记号），整段复述
  lines.push("\n[长度扫描] 纯文字单行笔记，答案 = 原文整段复述（问句不含原文）");
  const base = "服务器密码是九个八再加一个零然后是我的生日再倒过来写一遍最后补上公司缩写的大写形式再加两个感叹号结束";
  const sweep: string[] = [];
  for (let n = 4; n <= 60; n += 2) {
    const t = [...base].slice(0, n).join("");
    const r = echoClosed(t);
    sweep.push(`${n}:${r.survives ? "过" : "收"}`);
  }
  lines.push("  " + sweep.join(" "));
  lines.push("[长度扫描] 两行纯文字（每行 <24 字）");
  const sweep2: string[] = [];
  for (let n = 4; n <= 46; n += 2) {
    const half = Math.floor(n / 2);
    const t = [...base].slice(0, half).join("") + "\n" + [...base].slice(half, n).join("");
    const r = echoClosed(t);
    sweep2.push(`${n}:${r.survives ? "过" : "收"}`);
  }
  lines.push("  " + sweep2.join(" "));
  lines.push("[长度扫描] 带 ASCII 记号（非宽判据）的行：`版本 v1.2.3 内部代号 xxxx…`");
  const sweep3: string[] = [];
  for (let n = 6; n <= 40; n += 2) {
    const t = "代号 v1.2.3 " + [...base].slice(0, n).join("");
    const r = echoClosed(t);
    sweep3.push(`${n + 5}:${r.survives ? "过" : "收"}(${broadFoldReason(t) ?? "-"})`);
  }
  lines.push("  " + sweep3.join(" "));

  writeFileSync("out/broad311.txt", lines.join("\n"));
  writeFileSync("out/broad311.json", JSON.stringify({ carriers: cRows, benign: bRows, new311: nRows, benign311: bnRows }, null, 1));
  console.log(lines.join("\n"));
});
