/**
 * Offline A/B eval for thread clustering scope: idea-only (current) vs
 * idea+collect (proposed). Replays a labeled corpus through the same decision
 * rule as threads.ts clusterNote — bge-m3 cosine prescreen (SIM_JOIN=0.76
 * direct join, 0.5..0.76 LLM-confirm band) with the production fallback model
 * (@cf/meta/llama-3.3-70b-instruct-fp8-fast) answering the same confirm
 * prompt — and scores pair precision/recall against topic labels.
 *
 * Usage: CLOUDFLARE_API_TOKEN=... npx tsx scripts/thread-cross-eval.ts
 * (token needs Workers AI read; account id is auto-discovered)
 */

const SIM_JOIN = 0.76;
const SIM_CANDIDATE = 0.5;
/** Stricter confirm floor when a collect note is involved (mirrors SIM_CANDIDATE_FRUGAL). */
const SIM_CANDIDATE_CROSS = 0.62;
const EMBED_MODEL = "@cf/baai/bge-m3";
const CONFIRM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface Frag {
  id: string;
  category: "idea" | "collect";
  /** null = distractor that must not join any thread */
  topic: string | null;
  title: string | null;
  content: string;
}

// Realistic corpus: 6 cross-category topics (the "collect an article + drop a
// thought" combo audit-r103 §3.1 calls the most typical), 3 idea-only topics
// (regression guard), plus one-off distractor collects/ideas — the most common
// real-world collect usage is unrelated single articles, which is exactly
// where cross-category clustering could over-join.
const CORPUS: Frag[] = [
  // T1 西班牙旅行 (collect + idea + idea)
  { id: "t1a", category: "collect", topic: "T1", title: "巴塞罗那自由行全攻略", content: "https://example.com/bcn 收藏：巴塞罗那自由行攻略，圣家堂、古埃尔公园、哥特区三日路线，含地铁购票与省钱贴士" },
  { id: "t1b", category: "idea", topic: "T1", title: null, content: "想法：十月去西班牙的话，巴塞罗那至少留三天，圣家堂一定要提前订票，傍晚光线最好" },
  { id: "t1c", category: "idea", topic: "T1", title: null, content: "西班牙行程再想了下：巴塞罗那之后坐火车去马德里，把普拉多博物馆排进去" },
  // T2 独立开发副业 (idea + idea + collect)
  { id: "t2a", category: "idea", topic: "T2", title: null, content: "想做一个独立开发的小产品当副业，先从解决自己的记账痛点开始，小而美就好" },
  { id: "t2b", category: "collect", topic: "T2", title: "独立开发者如何找到前 100 个用户", content: "https://example.com/indie 收藏的文章：独立开发者冷启动，从垂直社区、Build in Public 和 SEO 三条路找到前 100 个付费用户" },
  { id: "t2c", category: "idea", topic: "T2", title: null, content: "副业产品的定价想法：独立开发早期就该收费，哪怕 9 块钱，免费用户的反馈会带偏方向" },
  // T3 读《置身事内》 (collect + idea)
  { id: "t3a", category: "collect", topic: "T3", title: "《置身事内》书评：理解中国政府经济行为", content: "https://example.com/book 书评收藏：《置身事内》讲地方政府发展经济的逻辑，土地财政与城投的来龙去脉" },
  { id: "t3b", category: "idea", topic: "T3", title: null, content: "读《置身事内》的感想：土地财政那章解释了为什么基建扩张停不下来，跟我老家的新区烂尾对上了" },
  // T4 健身增肌 (idea + collect)
  { id: "t4a", category: "idea", topic: "T4", title: null, content: "决定重新开始健身，目标半年增肌五公斤，先把深蹲和硬拉动作学标准" },
  { id: "t4b", category: "collect", topic: "T4", title: "新手力量训练指南：五大复合动作", content: "https://example.com/gym 收藏：新手力量训练从深蹲、硬拉、卧推、划船、推举五大复合动作开始，每周三练足够" },
  // T5 AI 笔记产品竞品 (idea + collect + idea)
  { id: "t5a", category: "idea", topic: "T5", title: null, content: "AI 笔记产品的核心差异化想法：不让用户整理，AI 自动分拣和串线索，用户只管往里丢" },
  { id: "t5b", category: "collect", topic: "T5", title: "mymind：无文件夹的 AI 收藏夹", content: "https://example.com/mymind 竞品文章收藏：mymind 主打无文件夹无标签，AI 自动识别收藏内容类型，搜索即整理" },
  { id: "t5c", category: "idea", topic: "T5", title: null, content: "AI 笔记再想：mymind 那种全自动路线的问题是用户不信任黑盒，我们的线索页应该展示为什么这几条被串在一起" },
  // T6 厨房装修 (collect + idea)
  { id: "t6a", category: "collect", topic: "T6", title: "小户型厨房装修避坑指南", content: "https://example.com/kitchen 收藏：小户型厨房装修，动线按洗切炒排、台面高度按身高定制、抽屉比柜门好用" },
  { id: "t6b", category: "idea", topic: "T6", title: null, content: "厨房装修的想法：台面一定要做高低台，洗菜区抬高炒菜区降低，妈妈腰不好这点最重要" },
  // T7-T9 idea-only topics（回归保障：现行为不能被扩类破坏）
  { id: "t7a", category: "idea", topic: "T7", title: null, content: "学西班牙语的想法：每天 Duolingo 十五分钟不够，得配合看《纸钞屋》原声磨耳朵" },
  { id: "t7b", category: "idea", topic: "T7", title: null, content: "西语学习进展想法：动词变位还是背不住，试试把常用二十个动词做成手机壁纸" },
  { id: "t8a", category: "idea", topic: "T8", title: null, content: "给爸妈换手机的想法：屏幕要大、字体要大，最好能远程协助，预算两千以内" },
  { id: "t8b", category: "idea", topic: "T8", title: null, content: "爸妈手机这事再想：与其换新机不如把旧手机设置好长辈模式，先试一周" },
  { id: "t9a", category: "idea", topic: "T9", title: null, content: "周报制度的想法：团队周报改成三行——本周最重要的事、卡住的事、下周第一件事" },
  { id: "t9b", category: "idea", topic: "T9", title: null, content: "周报再想：三行周报试了两周，卡住的事一栏最有价值，应该在周会上逐条过" },
  // 干扰项：一次性收藏（最常见的 collect 用法，绝不能被误聚）
  { id: "d1", category: "collect", topic: null, title: "2026 年个税专项附加扣除申报指南", content: "https://example.com/tax 收藏备查：个税专项附加扣除申报流程与材料清单" },
  { id: "d2", category: "collect", topic: null, title: "一文看懂 HTTP/3 与 QUIC", content: "https://example.com/http3 技术文章收藏：HTTP/3 基于 QUIC 的握手与拥塞控制改进" },
  { id: "d3", category: "collect", topic: null, title: "米其林主厨的家常红烧肉做法", content: "https://example.com/pork 菜谱收藏：红烧肉先煸后炖，冰糖炒糖色是关键" },
  { id: "d4", category: "collect", topic: null, title: "日本京都红叶季最佳观赏地图", content: "https://example.com/kyoto 收藏：京都红叶 11 月中下旬最佳，永观堂夜枫要预约" },
  { id: "d5", category: "collect", topic: null, title: "如何给猫科学换粮", content: "https://example.com/cat 收藏：猫换粮要七日渐进混合，突然换粮易软便" },
  { id: "d6", category: "collect", topic: null, title: "央行降准对房贷利率的影响解读", content: "https://example.com/rate 收藏：降准释放流动性，存量房贷利率跟随 LPR 调整" },
  { id: "d7", category: "collect", topic: null, title: "露营装备清单：从入门到进阶", content: "https://example.com/camp 收藏：三季帐、充气垫、炉具，新手先租后买" },
  { id: "d8", category: "collect", topic: null, title: "TypeScript 5.5 新特性一览", content: "https://example.com/ts55 技术收藏：推断谓词、正则语法检查、隔离声明" },
  // 干扰项：一次性想法
  { id: "d9", category: "idea", topic: null, title: null, content: "突然想到：小区快递柜取件高峰在晚八点，物业其实可以错峰发取件码" },
  { id: "d10", category: "idea", topic: null, title: null, content: "随手想法：会议室的白板笔总是没水，放一个归还时自检的笔筒试试" },
  { id: "d11", category: "idea", topic: null, title: null, content: "想法：早上通勤听播客比听歌状态好，也许该整理一个通勤播客清单" },
  { id: "d12", category: "idea", topic: null, title: null, content: "闪念：给阳台的绿萝换个自动滴灌，出差两周就不用麻烦邻居了" },
];

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_WORKERS_API_TOKEN;

async function cf(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!json.success) throw new Error(`CF API failed: ${JSON.stringify(json.errors)}`);
  return json.result;
}

async function accountId(): Promise<string> {
  const res = await fetch(`${API}/accounts`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = (await res.json()) as any;
  if (!json.success || !json.result?.[0]?.id) throw new Error("cannot resolve account id");
  return json.result[0].id;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let confirmCalls = 0;
async function llmConfirmPair(acc: string, a: string, b: string): Promise<boolean> {
  confirmCalls++;
  const r = await cf(`/accounts/${acc}/ai/run/${CONFIRM_MODEL}`, {
    temperature: 0,
    max_tokens: 10,
    messages: [
      { role: "system", content: "判断下面两条想法是否属于同一主题（可以串成同一条思考线索）。是则输出 1，否则输出 0。只输出数字。" },
      { role: "user", content: `想法A：${a.slice(0, 400)}\n\n想法B：${b.slice(0, 400)}` },
    ],
  });
  return parseInt(String(r.response ?? "").trim(), 10) === 1;
}

/** Sequential replay of clusterNote's embedding path over in-scope fragments. */
async function simulate(acc: string, frags: Frag[], vecs: Map<string, number[]>, crossFloor = false): Promise<Map<string, string>> {
  const threadOf = new Map<string, string>(); // frag id -> thread id
  let nextThread = 0;
  const seen: Frag[] = [];
  for (const f of frags) {
    let best: { frag: Frag; sim: number } | null = null;
    for (const p of seen) {
      const sim = cosineSim(vecs.get(f.id)!, vecs.get(p.id)!);
      if (!best || sim > best.sim) best = { frag: p, sim };
    }
    if (best) {
      const direct = best.sim >= SIM_JOIN;
      const floor =
        crossFloor && (f.category === "collect" || best.frag.category === "collect")
          ? SIM_CANDIDATE_CROSS
          : SIM_CANDIDATE;
      const confirmed =
        !direct &&
        best.sim >= floor &&
        (await llmConfirmPair(acc, f.title || f.content, best.frag.title || best.frag.content));
      if (direct || confirmed) {
        let tid = threadOf.get(best.frag.id);
        if (!tid) {
          tid = `th${nextThread++}`;
          threadOf.set(best.frag.id, tid);
        }
        threadOf.set(f.id, tid);
        console.log(`  join ${f.id} -> ${best.frag.id} (sim=${best.sim.toFixed(3)} ${direct ? "direct" : "confirmed"})`);
      } else {
        console.log(`  solo ${f.id} (best=${best.frag.id} sim=${best.sim.toFixed(3)})`);
      }
    }
    seen.push(f);
  }
  return threadOf;
}

function score(name: string, frags: Frag[], threadOf: Map<string, string>) {
  let tp = 0, fp = 0, fn = 0;
  const fpPairs: string[] = [];
  const fnPairs: string[] = [];
  for (let i = 0; i < frags.length; i++) {
    for (let j = i + 1; j < frags.length; j++) {
      const a = frags[i], b = frags[j];
      const together = threadOf.get(a.id) !== undefined && threadOf.get(a.id) === threadOf.get(b.id);
      const should = a.topic !== null && a.topic === b.topic;
      if (together && should) tp++;
      else if (together && !should) { fp++; fpPairs.push(`${a.id}+${b.id}`); }
      else if (!together && should) { fn++; fnPairs.push(`${a.id}+${b.id}`); }
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  console.log(`\n[${name}] pair precision=${(precision * 100).toFixed(1)}% (${tp}/${tp + fp})  recall=${(recall * 100).toFixed(1)}% (${tp}/${tp + fn})`);
  if (fpPairs.length) console.log(`  误聚 (FP): ${fpPairs.join(", ")}`);
  if (fnPairs.length) console.log(`  漏聚 (FN): ${fnPairs.join(", ")}`);
  return { precision, recall, tp, fp, fn };
}

async function main() {
  if (!TOKEN) throw new Error("set CLOUDFLARE_API_TOKEN (Workers AI read)");
  const acc = await accountId();
  const texts = CORPUS.map((f) => `${f.title ?? ""}\n${f.content}`.slice(0, 1000));
  const vecs = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i += 20) {
    const r = await cf(`/accounts/${acc}/ai/run/${EMBED_MODEL}`, { text: texts.slice(i, i + 20) });
    (r.data as number[][]).forEach((v, k) => vecs.set(CORPUS[i + k].id, v));
  }
  console.log(`embedded ${vecs.size} fragments (${EMBED_MODEL})\n`);

  console.log("=== Policy A: idea-only (current production) ===");
  const ideaOnly = CORPUS.filter((f) => f.category === "idea");
  const a = await simulate(acc, ideaOnly, vecs);
  // score A over the FULL corpus so cross-category topics count as misses
  const sa = score("A idea-only, scored on full corpus", CORPUS, a);

  console.log(`\n=== Policy B: idea+collect (proposed) ===`);
  const b = await simulate(acc, CORPUS, vecs);
  const sb = score("B idea+collect", CORPUS, b);

  console.log(`\n=== Policy B': idea+collect, collect confirm floor ${SIM_CANDIDATE_CROSS} ===`);
  const b2 = await simulate(acc, CORPUS, vecs, true);
  const sb2 = score("B' idea+collect strict", CORPUS, b2);

  console.log(`\nLLM confirm calls total: ${confirmCalls} (model ${CONFIRM_MODEL})`);
  console.log(`\nSummary: A ${(sa.recall * 100).toFixed(0)}%R/${(sa.precision * 100).toFixed(0)}%P  B ${(sb.recall * 100).toFixed(0)}%R/${(sb.precision * 100).toFixed(0)}%P  B' ${(sb2.recall * 100).toFixed(0)}%R/${(sb2.precision * 100).toFixed(0)}%P`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
