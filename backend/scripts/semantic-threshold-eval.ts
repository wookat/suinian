/**
 * R160 P1-1 threshold calibration for semantic recall (bge-m3 cosine).
 *
 * Embeds a realistic note corpus (mirrors the audit-r159 QA corpus mix: emoji,
 * links, long pastes, multilingual, todos, finance, coffee-shop ideas, Spanish
 * learning) plus two query sets:
 *   - relevant: paraphrase queries with labelled expected notes
 *   - irrelevant: garbage / off-corpus queries that must return nothing
 * and prints per-threshold recall / false-positive counts (ROC-style sweep) so
 * SEMANTIC_MIN_SCORE can be set from evidence instead of guesswork.
 *
 * Run: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx tsx scripts/semantic-threshold-eval.ts
 * (needs a token with Workers AI Run; embeddings go through the same
 * @cf/baai/bge-m3 model production uses, text sliced to 1000 chars like
 * semantic.ts embedText.)
 */

import { hasSemanticSignal } from "../src/semantic";

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) {
  console.error("CLOUDFLARE_ACCOUNT_ID required");
  process.exit(1);
}
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN required");
  process.exit(1);
}

// ---- corpus: mirrors the audit-r159 49-note QA mix ----
const corpus: { id: string; text: string }[] = [
  { id: "emoji1", text: "🎉🎉🎉" },
  { id: "emoji2", text: "😭😭 太难了 💪" },
  { id: "link1", text: "https://example.com/d1-pricing Cloudflare D1 定价页" },
  { id: "coffee1", text: "想开一家社区咖啡店，主打手冲和轻食，选址在大学城附近" },
  { id: "coffee2", text: "咖啡店的会员体系可以做成集章卡，买十送一" },
  { id: "coffee3", text: "看了一篇咖啡店经营指南，前期投入大概 30 万，回本周期 18 个月" },
  { id: "coffee4", text: "咖啡机选 La Marzocco 还是 Slayer？预算 8 万以内" },
  { id: "es1", text: "今天学了西班牙语的过去时变位，hablar → hablé" },
  { id: "es2", text: "为什么学西语：明年想去墨西哥旅行，顺便看看当地的咖啡产地" },
  { id: "es3", text: "Duolingo 连续打卡 45 天，西语词汇量大概 800 了" },
  { id: "todo1", text: "明天下午四点带猫去打疫苗" },
  { id: "todo2", text: "周三之前把季度报告发给老板" },
  { id: "todo3", text: "下月15号续健身卡" },
  { id: "fin1", text: "打车去机场花了 ¥128.50" },
  { id: "fin2", text: "这个月工资到账 ¥12000，加上兼职 ¥600" },
  { id: "data1", text: "新电影《沙丘3》定档明年二月" },
  { id: "data2", text: "苹果发布会公告：新 MacBook 下周开卖" },
  { id: "idea1", text: "突然想到：周报可以自动从笔记里生成，不用手写" },
  { id: "tech1", text: "今天 standup 说了 blocker：D1 的 LIKE query 没有索引，数据量大了会变慢" },
  { id: "jp1", text: "明日の午後、歯医者の予約がある" },
  { id: "long1", text: "读书笔记：《原则》第三章讲到，痛苦+反思=进步。作者认为大多数人失败不是因为能力不足，而是不敢直面自己的弱点。".repeat(8) },
  { id: "voice1", text: "嗯嗯那个…下周…健身卡的事情别忘了" },
  { id: "cat1", text: "猫最近不爱吃猫粮了，考虑换成冻干" },
  { id: "gym1", text: "健身房的私教课一节 ¥300，感觉有点贵" },
  { id: "wifi1", text: "家里 WiFi 密码改成了 sunshine2026" },
];

// ---- relevant queries: paraphrases, must keep recalling ----
const relevant: { q: string; expect: string[] }[] = [
  { q: "煮咖啡的设备怎么选", expect: ["coffee4"] },
  { q: "开店要投入多少钱", expect: ["coffee3"] },
  { q: "学外语的进度", expect: ["es1", "es3"] },
  { q: "宠物看病", expect: ["todo1", "cat1"] },
  { q: "锻炼身体的开销", expect: ["gym1"] },
  { q: "数据库性能问题", expect: ["tech1"] },
  { q: "去拉美国家玩", expect: ["es2"] },
  { q: "工资收入", expect: ["fin2"] },
];

// ---- irrelevant queries: must return nothing (audit-r159 P1-1 repro + off-corpus topics) ----
const irrelevant: string[] = [
  "zzzz9999",
  "zzzznotexist无此内容",
  "qqqqwwwweeee",
  "asdkjhqwe987",
  "量子引力理论的最新进展",
  "冰岛极光观测攻略",
  "如何修理拖拉机变速箱",
  "NBA 总决赛比分",
  "腌笃鲜的做法",
  "区块链挖矿显卡",
];

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20).map((t) => t.slice(0, 1000));
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/baai/bge-m3`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: batch }),
    });
    const j = (await res.json()) as { success: boolean; result?: { data?: number[][] }; errors?: unknown };
    if (!j.success || !j.result?.data) throw new Error(`embed failed: ${JSON.stringify(j.errors)}`);
    out.push(...j.result.data);
  }
  return out;
}

function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  const corpusVecs = await embed(corpus.map((c) => c.text));
  const relVecs = await embed(relevant.map((r) => r.q));
  const irrVecs = await embed(irrelevant);

  const relScores: { q: string; id: string; score: number; expected: boolean }[] = [];
  relevant.forEach((r, qi) => {
    corpus.forEach((c, ci) => {
      relScores.push({ q: r.q, id: c.id, score: cos(relVecs[qi], corpusVecs[ci]), expected: r.expect.includes(c.id) });
    });
  });
  const irrScores: { q: string; id: string; score: number }[] = [];
  irrelevant.forEach((q, qi) => {
    corpus.forEach((c, ci) => {
      irrScores.push({ q, id: c.id, score: cos(irrVecs[qi], corpusVecs[ci]) });
    });
  });

  console.log("== relevant query → expected-note scores (must stay above threshold) ==");
  for (const s of relScores.filter((s) => s.expected).sort((a, b) => a.score - b.score)) {
    console.log(`  ${s.score.toFixed(4)}  ${s.q}  →  ${s.id}`);
  }

  console.log("\n== irrelevant query → top-3 scores per query (must fall below threshold) ==");
  for (const q of irrelevant) {
    const top = irrScores.filter((s) => s.q === q).sort((a, b) => b.score - a.score).slice(0, 3);
    console.log(`  ${q}: ${top.map((t) => `${t.id}=${t.score.toFixed(4)}`).join("  ")}`);
  }

  console.log("\n== threshold sweep (ROC) ==");
  console.log("thr    rel-recall     irrelevant-FP(pairs)  irrelevant-queries-with-any-hit");
  const expectedPairs = relScores.filter((s) => s.expected);
  for (let thr = 0.35; thr <= 0.76; thr += 0.025) {
    const recall = expectedPairs.filter((s) => s.score >= thr).length;
    const fp = irrScores.filter((s) => s.score >= thr).length;
    const qHit = new Set(irrScores.filter((s) => s.score >= thr).map((s) => s.q)).size;
    console.log(
      `${thr.toFixed(3)}  ${recall}/${expectedPairs.length}          ${fp}                     ${qHit}/${irrelevant.length}`
    );
  }

  console.log("\n== distribution summary ==");
  const exp = expectedPairs.map((s) => s.score).sort((a, b) => a - b);
  const irr = irrScores.map((s) => s.score).sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.floor((arr.length - 1) * p)];
  console.log(`relevant-expected: min=${exp[0].toFixed(4)} p25=${pct(exp, 0.25).toFixed(4)} median=${pct(exp, 0.5).toFixed(4)} max=${exp[exp.length - 1].toFixed(4)}`);
  console.log(`irrelevant pairs:  p90=${pct(irr, 0.9).toFixed(4)} p99=${pct(irr, 0.99).toFixed(4)} max=${irr[irr.length - 1].toFixed(4)}`);

  // chosen production policy: threshold 0.5 + zero-signal notes excluded from
  // the vector store (semantic.ts hasSemanticSignal)
  console.log("\n== chosen policy: thr=0.5 + low-signal notes excluded ==");
  const signal = new Set(corpus.filter((c) => hasSemanticSignal(c.text)).map((c) => c.id));
  const THR = 0.5;
  const recall = expectedPairs.filter((s) => s.score >= THR && signal.has(s.id)).length;
  const fps = irrScores.filter((s) => s.score >= THR && signal.has(s.id));
  console.log(`relevant recall: ${recall}/${expectedPairs.length}`);
  console.log(`irrelevant FP pairs: ${fps.length}${fps.length ? " — " + fps.map((f) => `${f.q}→${f.id}=${f.score.toFixed(4)}`).join(", ") : ""}`);
  console.log(`excluded low-signal notes: ${corpus.filter((c) => !signal.has(c.id)).map((c) => c.id).join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
