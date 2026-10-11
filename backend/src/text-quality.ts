/** 模型退化乱码（同词循环、同片段连续重复）：不能当答案 / 正文下发。 */
export function isDegenerateText(input: string): boolean {
  const text = input.trim();
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length >= 12) {
    const uniq = new Set(toks.map((t) => t.toLowerCase().replace(/[.,;:!?。，！？]/g, "")));
    if (uniq.size / toks.length < 0.25) return true;
  }
  const m = /(.{2,8}?)\1{5,}/s.exec(text);
  return m !== null && m[0].length >= 30 && m[0].length * 2 >= text.length;
}

const INDEX_ECHO_LINE_RE = /^(\d+)[.、)．]\s*\1$/;

/**
 * 视觉模型对空白 / 全黑等无内容图片会陷入生成循环：「1.  1.  1. …」、
 * 「1. 1\n2. 2\n3. 3 …」、同一时间戳整行重复，直到 max_tokens 截断。
 * 逐行看：≥ 6 行且每行都是「序号. 同一个数」的自我回声，或行去重后只剩
 * 很少几种，都不是任何真实票据 / 白板能抽出来的文字；纯数字金额列不在此列。
 */
export function isDegenerateLines(input: string): boolean {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 6) return false;
  // max_tokens 截断会留半行，末行不参与判定
  const whole = lines.slice(0, -1);
  if (whole.length >= 6 && whole.every((l) => INDEX_ECHO_LINE_RE.test(l))) return true;
  const uniq = new Set(lines);
  return uniq.size * 4 <= lines.length;
}
