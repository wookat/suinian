/**
 * Offline A/B eval for thread clustering scope: idea+collect (current, R106)
 * vs idea+collect+todo (R165 P2 proposal). Replays a labeled corpus through
 * the same decision rule as threads.ts clusterNote — bge-m3 cosine prescreen
 * (SIM_JOIN=0.76 direct join, confirm band down to the per-category floor)
 * with the production fallback model (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
 * answering the same confirm prompt — and scores pair precision/recall
 * against topic labels.
 *
 * The risk profile mirrors thread-cross-eval: most real-world todos are
 * one-off chores（买牙膏/交电费/回电话）that must never join a thread, while
 * the R165 finding is about project-like todos that share a theme with
 * existing idea/collect notes.
 *
 * Usage: CLOUDFLARE_API_TOKEN=... npx tsx scripts/thread-todo-eval.ts
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
  category: "idea" | "collect" | "todo";
  /** null = distractor that must not join any thread */
  topic: string | null;
  title: string | null;
  content: string;
}

// Corpus: 6 topics where a project-like todo shares the theme with idea/collect
// notes (the R165 case), 3 idea/collect-only topics (regression guard), plus
// one-off chore todos and unrelated collects/ideas as distractors — chores are
// the dominant real-world todo usage and exactly where including todos could
// over-join.
const CORPUS: Frag[] = [
  // T1 学日语 (idea + todo + collect)
  { id: "t1a", category: "idea", topic: "T1", title: null, content: "想法：想系统学日语，目标明年 N3，先从五十音和常用寒暄开始" },
  { id: "t1b", category: "todo", topic: "T1", title: null, content: "待办：本周内把日语五十音图背完，每天早晚各过一遍平假名" },
  { id: "t1c", category: "collect", topic: "T1", title: "零基础日语自学路线图", content: "https://example.com/jp 收藏：零基础到 N3 的日语自学路线，教材选新标日，配合 Anki 记词" },
  // T2 搬家 (todo + idea)
  { id: "t2a", category: "todo", topic: "T2", title: null, content: "待办：月底前联系搬家公司拿三家报价，确认电梯预约和纸箱数量" },
  { id: "t2b", category: "idea", topic: "T2", title: null, content: "搬家的想法：这次按房间打包贴颜色标签，先把过季衣物和书装箱，最后动厨房" },
  // T3 独立开发副业 (idea + todo + collect)
  { id: "t3a", category: "idea", topic: "T3", title: null, content: "想做一个独立开发的小产品当副业，先从解决自己的记账痛点开始，小而美就好" },
  { id: "t3b", category: "todo", topic: "T3", title: null, content: "待办：周末把副业记账产品的落地页做出来，挂上候补名单收集邮箱" },
  { id: "t3c", category: "collect", topic: "T3", title: "独立开发者如何找到前 100 个用户", content: "https://example.com/indie 收藏的文章：独立开发者冷启动，从垂直社区、Build in Public 和 SEO 三条路找到前 100 个付费用户" },
  // T4 健身增肌 (idea + todo)
  { id: "t4a", category: "idea", topic: "T4", title: null, content: "决定重新开始健身，目标半年增肌五公斤，先把深蹲和硬拉动作学标准" },
  { id: "t4b", category: "todo", topic: "T4", title: null, content: "待办：明晚去健身房找教练约一节深蹲硬拉的动作矫正课" },
  // T5 体检报告随访 (todo + collect)
  { id: "t5a", category: "collect", topic: "T5", title: "体检报告怎么看：常见指标解读", content: "https://example.com/health 收藏：体检报告常见指标解读，转氨酶、尿酸、甲状腺结节的随访建议" },
  { id: "t5b", category: "todo", topic: "T5", title: null, content: "待办：预约下月甲状腺结节复查 B 超，把去年体检报告找出来带上" },
  // T6 厨房装修 (collect + idea + todo)
  { id: "t6a", category: "collect", topic: "T6", title: "小户型厨房装修避坑指南", content: "https://example.com/kitchen 收藏：小户型厨房装修，动线按洗切炒排、台面高度按身高定制、抽屉比柜门好用" },
  { id: "t6b", category: "idea", topic: "T6", title: null, content: "厨房装修的想法：台面一定要做高低台，洗菜区抬高炒菜区降低，妈妈腰不好这点最重要" },
  { id: "t6c", category: "todo", topic: "T6", title: null, content: "待办：周六约橱柜设计师上门量尺，确认高低台方案和抽屉配置" },
  // T7-T9 idea/collect-only topics（回归保障：现行为不能被扩类破坏）
  { id: "t7a", category: "idea", topic: "T7", title: null, content: "学西班牙语的想法：每天 Duolingo 十五分钟不够，得配合看《纸钞屋》原声磨耳朵" },
  { id: "t7b", category: "idea", topic: "T7", title: null, content: "西语学习进展想法：动词变位还是背不住，试试把常用二十个动词做成手机壁纸" },
  { id: "t8a", category: "idea", topic: "T8", title: null, content: "AI 笔记产品的核心差异化想法：不让用户整理，AI 自动分拣和串线索，用户只管往里丢" },
  { id: "t8b", category: "collect", topic: "T8", title: "mymind：无文件夹的 AI 收藏夹", content: "https://example.com/mymind 竞品文章收藏：mymind 主打无文件夹无标签，AI 自动识别收藏内容类型，搜索即整理" },
  { id: "t9a", category: "idea", topic: "T9", title: null, content: "周报制度的想法：团队周报改成三行——本周最重要的事、卡住的事、下周第一件事" },
  { id: "t9b", category: "idea", topic: "T9", title: null, content: "周报再想：三行周报试了两周，卡住的事一栏最有价值，应该在周会上逐条过" },
  // 干扰项：一次性琐事待办（最常见的 todo 用法，绝不能被误聚）
  { id: "d1", category: "todo", topic: null, title: null, content: "待办：明天下午三点前给牙医回电话，预约洗牙" },
  { id: "d2", category: "todo", topic: null, title: null, content: "待办：今晚交这个月的电费和物业费" },
  { id: "d3", category: "todo", topic: null, title: null, content: "待办：下班路上买牙膏、垃圾袋和猫砂" },
  { id: "d4", category: "todo", topic: null, title: null, content: "待办：周五把快递退货寄出去，运单号在邮箱里" },
  { id: "d5", category: "todo", topic: null, title: null, content: "待办：给车做保养，顺便让师傅看看右后胎慢漏气" },
  { id: "d6", category: "todo", topic: null, title: null, content: "待办：明早九点开产品周会前把演示环境重启一遍" },
  { id: "d7", category: "todo", topic: null, title: null, content: "待办：护照下月到期，抽空去出入境大厅换新" },
  { id: "d8", category: "todo", topic: null, title: null, content: "待办：把妈妈的降压药在药店 App 上续购两盒" },
  // 干扰项：一次性收藏与想法
  { id: "d9", category: "collect", topic: null, title: "2026 年个税专项附加扣除申报指南", content: "https://example.com/tax 收藏备查：个税专项附加扣除申报流程与材料清单" },
  { id: "d10", category: "collect", topic: null, title: "一文看懂 HTTP/3 与 QUIC", content: "https://example.com/http3 技术文章收藏：HTTP/3 基于 QUIC 的握手与拥塞控制改进" },
  { id: "d11", category: "idea", topic: null, title: null, content: "突然想到：小区快递柜取件高峰在晚八点，物业其实可以错峰发取件码" },
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
async function simulate(
  acc: string,
  frags: Frag[],
  vecs: Map<string, number[]>,
  todoFloor?: number
): Promise<Map<string, string>> {
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
      const cross = f.category === "collect" || best.frag.category === "collect";
      const todoInvolved = f.category === "todo" || best.frag.category === "todo";
      const floor = todoInvolved
        ? (todoFloor ?? SIM_CANDIDATE_CROSS)
        : cross
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

  console.log("=== Policy A: idea+collect (current production, todos excluded) ===");
  const inScope = CORPUS.filter((f) => f.category !== "todo");
  const a = await simulate(acc, inScope, vecs);
  // score A over the FULL corpus so todo-involving topics count as misses
  const sa = score("A idea+collect, scored on full corpus", CORPUS, a);

  console.log(`\n=== Policy B: idea+collect+todo, todo confirm floor ${SIM_CANDIDATE_CROSS} ===`);
  const b = await simulate(acc, CORPUS, vecs);
  const sb = score("B +todo strict floor", CORPUS, b);

  console.log(`\n=== Policy B': idea+collect+todo, todo confirm floor ${SIM_CANDIDATE} ===`);
  const b2 = await simulate(acc, CORPUS, vecs, SIM_CANDIDATE);
  const sb2 = score("B' +todo loose floor", CORPUS, b2);

  console.log(`\nLLM confirm calls total: ${confirmCalls} (model ${CONFIRM_MODEL})`);
  console.log(
    `\nSummary: A ${(sa.recall * 100).toFixed(0)}%R/${(sa.precision * 100).toFixed(0)}%P  B ${(sb.recall * 100).toFixed(0)}%R/${(sb.precision * 100).toFixed(0)}%P  B' ${(sb2.recall * 100).toFixed(0)}%R/${(sb2.precision * 100).toFixed(0)}%P`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
