// R315：跨载体「任意危险片段」扫描——prod/ask.mjs 每行只按本载体 needles 量存活，模型在 single_note_direct
// 下引用到另一条笔记（检索命中不同于问句所指的载体）时，泄漏的是**别的载体**的值，本载体口径记 survive=[]。
// 这里把语料全部 danger needles 对每个答案（REST answer / SSE emitted）再扫一遍，报告 (载体/问法) → 命中的 (来源载体:needle)。
// 用法：node prod/cross-needles.mjs <label> [ask-json 文件名，默认 prod-ask-<label>.json]
import { readFileSync } from "node:fs";
const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
const file = process.argv[3] ?? `prod-ask-${label}.json`;
const acct = JSON.parse(readFileSync(`${OUT}/prod-${label}-account.json`, "utf8"));
const corpus = JSON.parse(readFileSync(`${OUT}/${acct.corpus}.json`, "utf8"));
const rows = JSON.parse(readFileSync(`${OUT}/${file}`, "utf8"));
const norm = (s) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// 短 needle（归一化 <4）太容易撞善意文本，只在其来源载体自身行里计；跨载体只数 ≥4
const needles = corpus.filter((c) => c.cat === "danger").flatMap((c) => (c.needles ?? []).map((n) => ({ src: c.id, n, nn: norm(n) })));
const hitsIn = (text, selfId) => {
  const a = norm(String(text ?? "").replace(/〔[^〕]*〕/g, ""));
  const raw = String(text ?? "");
  const out = [];
  for (const { src, n, nn } of needles) {
    if (src === selfId) continue;
    if (nn.length ? nn.length >= 4 && a.includes(nn) : raw.includes(n)) out.push(`${src}:${n}`);
  }
  return [...new Set(out)];
};
let total = 0, direct = 0, agg = 0;
const perTier = { single_note_direct: [], aggregate: [] };
for (const [id, modes] of Object.entries(rows)) {
  for (const [mode, r] of Object.entries(modes ?? {})) {
    if (!r || typeof r !== "object" || r.status !== 200) continue;
    const h = hitsIn(r.answer, id);
    const he = r.emitted ? hitsIn(r.emitted, id) : [];
    const all = [...new Set([...h, ...he])];
    if (!all.length) continue;
    total++;
    const tier = r.trust_tier ?? "aggregate";
    if (tier === "single_note_direct") direct++; else agg++;
    (perTier[tier] ?? (perTier[tier] = [])).push(`${id}/${mode} [${tier}] -> ${all.join(" , ")} :: ${String(r.answer).replace(/\n/g, "⏎").slice(0, 140)}`);
  }
}
console.log(`[${label}/${file}] cross-carrier needle hits: rows=${total} direct=${direct} aggregate=${agg}`);
for (const [t, arr] of Object.entries(perTier)) for (const l of arr) console.log(`  ${l}`);
