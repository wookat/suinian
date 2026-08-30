/**
 * R295 独立 verbatim 逐字契约评测（≥15 例，形态与 R294 的 14 例不重复）：
 *   npx tsx scripts/r295-verbatim-eval.ts [--verbose]
 * 判据：verbatim 问法 + 模型原样回声时，出口文本必须与资料原文逐码点相等
 *      （无隔离标记场景）；不等则给出首个差异位置的码点对照。
 */
import { finalizeAskAnswer } from "../src/prompt-armor";

const cases: Array<{ id: string; kind: string; text: string }> = [
  { id: "V01", kind: "Windows CRLF 与 LF 混排", text: "第一行\r\n第二行\n第三行\r\n" },
  { id: "V02", kind: "NFD 组合字符（é = e + U+0301）", text: "cafe\u0301 与 résumé 的对照：naı\u0308ve" },
  { id: "V03", kind: "变体选择符 VS15/VS16", text: "心形 \u2764\uFE0F 与 \u2764\uFE0E 两种呈现" },
  { id: "V04", kind: "区域指示符旗帜 emoji", text: "国旗：\u{1F1E8}\u{1F1F3} \u{1F1EF}\u{1F1F5} \u{1F1FA}\u{1F1F8}" },
  { id: "V05", kind: "超长单行（4000 字符）", text: "长行：" + "abcdefghij".repeat(400) },
  { id: "V06", kind: "控制字符 VT/FF/BEL", text: "A\u000BB\u000CC\u0007D" },
  { id: "V07", kind: "多重嵌套围栏（四反引号包三反引号）", text: "````md\n```js\nconsole.log(1)\n```\n````" },
  { id: "V08", kind: "ZWJ 家庭 emoji 序列", text: "全家福：\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}" },
  { id: "V09", kind: "肤色修饰符 + 性别符号", text: "\u{1F469}\u{1F3FD}\u200D\u{1F4BB} 在写代码" },
  { id: "V10", kind: "行尾尾随空格与 tab", text: "line1  \nline2\t\nline3   \t  " },
  { id: "V11", kind: "全角/半角混排 + 中文标点", text: "ＡＢＣａｂｃ１２３，。！？；：「」『』（）" },
  { id: "V12", kind: "RTL 文本（阿拉伯语，无攻击载体）", text: "阿拉伯语问候：مرحبا بالعالم，结束。" },
  { id: "V13", kind: "数学符号与上下标", text: "公式：x² + y₁ ≤ ∑ᵢ₌₁ⁿ aᵢ · √2 ≈ 1.414" },
  { id: "V14", kind: "连续空行与仅空白行", text: "段一\n\n\n   \n\t\n段二" },
  { id: "V15", kind: "YAML 缩进敏感块", text: "root:\n  child:\n    - a\n    -  b\n  other: |\n    保留换行\n    第二行" },
  { id: "V16", kind: "JSON 转义与反斜杠", text: '{"path":"C:\\\\Users\\\\me\\\\a.txt","re":"\\\\d+","q":"he said \\"hi\\""}' },
  { id: "V17", kind: "Unicode 行分隔符 U+2028/U+2029", text: "上段\u2028中段\u2029下段" },
  { id: "V18", kind: "泰文/天城文组合簇", text: "ไทย: สวัสดี / देवनागरी: नमस्ते" },
  { id: "V19", kind: "谚文组合 + 半角片假名", text: "한국어 조합: 각 / ﾊﾝｶｸ ｶﾀｶﾅ" },
  { id: "V20", kind: "Markdown 表格 + 行内代码", text: "| 项 | 值 |\n|---|---|\n| `a` | `b\\|c` |" },
];

const verbose = process.argv.includes("--verbose");
const Q = "把这条笔记的原文一字不改完整给我";
let pass = 0;
const fails: string[] = [];
for (const c of cases) {
  const out = finalizeAskAnswer(c.text, { dataText: c.text, question: Q, execDangerSegments: [] }).answer;
  const same = out === c.text;
  const bytesSame = Buffer.from(out, "utf8").equals(Buffer.from(c.text, "utf8"));
  if (same && bytesSame) {
    pass++;
    console.log(`PASS ${c.id} ${c.kind}`);
    continue;
  }
  const a = [...c.text], b = [...out];
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const cp = (s?: string) => (s === undefined ? "<EOF>" : `U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  fails.push(`${c.id} ${c.kind}: 首差异码点#${i} 原=${cp(a[i])} 出=${cp(b[i])}（长度 ${a.length}→${b.length}）`);
  console.log(`FAIL ${c.id} ${c.kind}`);
  if (verbose) console.log(`  in : ${JSON.stringify(c.text)}\n  out: ${JSON.stringify(out)}`);
}
console.log(`\nverbatim 逐字（模型完美回声）：${pass}/${cases.length} 完全一致`);
for (const f of fails) console.log(`  ! ${f}`);

// --- 模型有损回声：R294 声称由 restoreVerbatimEchoes() 用资料原始切片还原 ---
const lossy = (s: string) =>
  s.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "").replace(/[ \t]+/g, " ").replace(/\r\n/g, "\n");
let lpass = 0;
const lfails: string[] = [];
for (const c of cases) {
  const echo = lossy(c.text);
  if (echo === c.text) { lpass++; continue; }
  const out = finalizeAskAnswer(echo, { dataText: c.text, question: Q, execDangerSegments: [] }).answer;
  if (out === c.text) { lpass++; console.log(`RESTORE-PASS ${c.id}`); continue; }
  const a = [...c.text], b = [...out];
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  const cp = (s?: string) => (s === undefined ? "<EOF>" : `U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  lfails.push(`${c.id} ${c.kind}: 未还原，首差异#${i} 原=${cp(a[i])} 出=${cp(b[i])}`);
  console.log(`RESTORE-FAIL ${c.id} ${c.kind}`);
  if (verbose) console.log(`  echo: ${JSON.stringify(echo)}\n  out : ${JSON.stringify(out)}`);
}
console.log(`\nverbatim 还原（模型有损回声）：${lpass}/${cases.length}`);
for (const f of lfails) console.log(`  ! ${f}`);
