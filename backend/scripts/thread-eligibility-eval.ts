/**
 * R190 P1-3: offline A/B for decoupling thread-clustering ELIGIBILITY from the
 * triage category (audit-r189 §6.1 / D-1).
 *
 * R189 measured pair precision 80.0% / recall 47.1% with FOUR zero-thread
 * topic groups. Root cause attribution (audit §2.3):
 *   - 装修 (1 data + 1 idea + 2 todo) and 日语 (2 idea + 2 todo) lost to the
 *     category gate `THREAD_CATEGORIES = ('idea','collect')` — the topic was
 *     shredded by triage before clustering ever saw it. No threshold fixes this.
 *   - NAS / 写作 (all-idea corpus B) lost inside the similarity/confirm rule.
 *
 * This eval replays the production decision rule (bge-m3 prescreen,
 * SIM_JOIN=0.76 direct, floor 0.58 + top-3 LLM confirm — threads.ts) over a
 * labeled CROSS-CATEGORY corpus and compares:
 *   A: production baseline — eligibility = category IN (idea, collect)
 *   B: decoupled eligibility — category IN (idea, collect, todo, data)
 *      (finance categories stay out; sensitive/zero-signal stay out via the
 *      existing ensureNoteEmbedding gate, unchanged)
 *   C: B + leftover pairing pass — unthreaded eligible notes get one
 *      embedding-prescreened (sim >= 0.50) LLM-confirmed pairing attempt
 *      against other leftovers (bounded top-3), mirroring the cold-start
 *      deepseekPickNote path that today only runs when embeddings are down.
 *
 * Metrics per policy: pairwise precision / recall (all eligible-or-not notes
 * count toward truth, so the category gate's losses are visible — the R188
 * eval's blind spot) and the number of ZERO-THREAD topic groups.
 *
 * Usage: CLOUDFLARE_API_TOKEN=... npx tsx scripts/thread-eligibility-eval.ts
 */

const SIM_JOIN = 0.76;
const SIM_CONFIRM_FLOOR = 0.58;
const CONFIRM_TOP_K = 3;
const LEFTOVER_FLOOR = 0.5;
const EMBED_MODEL = "@cf/baai/bge-m3";
const CONFIRM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type Cat = "idea" | "collect" | "todo" | "data" | "expense";

interface Frag {
  id: string;
  topic: string | null; // null = distractor, must stay solo
  category: Cat;
  title: string | null;
  content: string;
}

// Cross-category topic groups mirroring the R189 failures (装修/日语 mixed
// categories, NAS/写作 all-idea), two regression topics from corpus A
// (晨跑/咖啡), the corpus-B 睡眠 group that previously absorbed a 写作 note
// (precision watch), and 15 distractor one-offs across categories (the
// precision risk of opening the pool: unrelated todos/data must stay solo).
const CORPUS: Frag[] = [
  // Z 装修 (1 data + 1 idea + 2 todo) — R189 zero-thread
  { id: "z1", topic: "Z", category: "idea", title: null, content: "想把老房子的厨房打通做开放式，岛台放中间，参考了几个小户型案例" },
  { id: "z2", topic: "Z", category: "todo", title: null, content: "周末约装修公司来量房，提前把户型图和承重墙位置图找出来" },
  { id: "z3", topic: "Z", category: "todo", title: null, content: "买卫生间瓷砖前先确认防滑等级，顺便问装修队墙砖要不要一起订" },
  { id: "z4", topic: "Z", category: "data", title: "装修报价", content: "装修公司报价：半包 8 万，全包 13.5 万，含水电改造和吊顶" },
  // J 日语 (2 idea + 2 todo) — R189 zero-thread
  { id: "j1", topic: "J", category: "idea", title: null, content: "背五十音图找到窍门了：按行联想记忆，あ行全是元音打底" },
  { id: "j2", topic: "J", category: "idea", title: null, content: "日语学习路线想法：先把动词变形啃下来，其他语法都是围绕它展开的" },
  { id: "j3", topic: "J", category: "todo", title: null, content: "今晚把五十音平假名默写一遍，错的抄十遍" },
  { id: "j4", topic: "J", category: "todo", title: null, content: "续订日语学习 App 的会员，把 N5 词汇包先下载好" },
  // N NAS (4 idea) — R189 zero-thread (corpus B, same-category failure)
  { id: "n1", topic: "N", category: "idea", title: null, content: "想把退役的老台式机改成家庭存储服务器，两块硬盘做 RAID1 镜像" },
  { id: "n2", topic: "N", category: "idea", title: null, content: "查了群晖的系统，黑群晖方案有升级风险，不如直接跑开源的 TrueNAS" },
  { id: "n3", topic: "N", category: "idea", title: null, content: "家庭存储的访问方式想好了：局域网走 SMB 共享，出门在外用 Tailscale 回家" },
  { id: "n4", topic: "N", category: "idea", title: null, content: "NAS 硬盘选型：企业盘性能好但噪音大，放客厅还是选静音的 NAS 专用盘" },
  // W 写作 (4 idea) — R189 zero-thread (corpus B)
  { id: "w1", topic: "W", category: "idea", title: null, content: "写东西的节奏改成先写烂初稿，第二天再改，比一次憋完顺畅多了" },
  { id: "w2", topic: "W", category: "idea", title: null, content: "公众号更新频率的想法：与其周更凑数，不如双周一篇认真写的长文" },
  { id: "w3", topic: "W", category: "idea", title: null, content: "写作素材收集习惯：把日常对话里有意思的表达随手记下来，写文章时翻" },
  { id: "w4", topic: "W", category: "idea", title: null, content: "发现文章写不下去就换个开头重写，卡住硬憋是最低效的写法" },
  // R 晨跑 (4 idea) — corpus A regression（R189 已能成线索，不许回归）
  { id: "r1", topic: "R", category: "idea", title: null, content: "开始晨跑第一周：五点半起床跑 3 公里，跑完整个人清醒" },
  { id: "r2", topic: "R", category: "idea", title: null, content: "晨跑配速想法：不追速度先追频率，隔天跑比每天跑更能坚持" },
  { id: "r3", topic: "R", category: "idea", title: null, content: "跑步路线换到江边了，早上人少空气好，比绕小区有意思" },
  { id: "r4", topic: "R", category: "idea", title: null, content: "晨跑一个月复盘：体重没怎么掉但睡眠明显变好，继续保持" },
  // C 咖啡 (4 idea) — corpus A regression
  { id: "c1", topic: "C", category: "idea", title: null, content: "手冲参数记录：15g 粉 225g 水 92 度三段注水，酸感刚好" },
  { id: "c2", topic: "C", category: "idea", title: null, content: "新到的耶加雪菲日晒豆，干香是莓果调，冲出来居然有酒感" },
  { id: "c3", topic: "C", category: "idea", title: null, content: "对比了 C40 和泰摩栗子磨豆机，C40 细粉少，手冲层次干净" },
  { id: "c4", topic: "C", category: "idea", title: null, content: "冷萃试验：1:12 粉水比冷藏 16 小时，比热冲甜感高不少" },
  // S 睡眠 (6 idea) — corpus B precision watch（此前把写作 w1 误吸入）
  { id: "s1", topic: "S", category: "idea", title: null, content: "最近入睡困难，试了睡前一小时不看手机，好像有点用" },
  { id: "s2", topic: "S", category: "idea", title: null, content: "查了睡眠卫生的资料：卧室温度 19 度左右最利于入睡" },
  { id: "s3", topic: "S", category: "idea", title: null, content: "想买遮光窗帘，凌晨五点天亮就醒，遮光可能是关键" },
  { id: "s4", topic: "S", category: "idea", title: null, content: "睡眠实验第三天：下午两点后不喝咖啡，入睡时间提前了半小时" },
  { id: "s5", topic: "S", category: "idea", title: null, content: "白噪音助眠试了雨声，比风扇声更容易让人放松入睡" },
  { id: "s6", topic: "S", category: "idea", title: null, content: "睡眠追踪一周数据：深睡占比 18%，周末补觉反而让周一更困" },
  // 干扰项：一次性笔记，正确行为是保持孤点（跨类别，特别是放开资格后的
  // todo/data 误聚风险）
  { id: "d01", topic: null, category: "todo", title: null, content: "下周三之前给房东转这个季度的房租" },
  { id: "d02", topic: null, category: "todo", title: null, content: "预约牙医洗牙，上次洗牙已经是一年前了" },
  { id: "d03", topic: null, category: "todo", title: null, content: "把过期的护照拿去出入境管理局换新" },
  { id: "d04", topic: null, category: "todo", title: null, content: "给猫买下个月的猫粮，这次换无谷配方试试" },
  { id: "d05", topic: null, category: "todo", title: null, content: "周五下班前把报销发票贴好交给行政" },
  { id: "d06", topic: null, category: "data", title: "个税申报", content: "个税专项附加扣除申报截止月底，记得上传房租合同" },
  { id: "d07", topic: null, category: "data", title: null, content: "体检报告出了：甘油三酯偏高，其他指标正常" },
  { id: "d08", topic: null, category: "data", title: "宽带续费", content: "宽带续费价格：500M 一年 720，1000M 一年 960" },
  { id: "d09", topic: null, category: "idea", title: null, content: "小区快递柜取件高峰在晚八点，物业可以错峰发取件码" },
  { id: "d10", topic: null, category: "idea", title: null, content: "会议室的白板笔总是没水，放一个归还时自检的笔筒试试" },
  { id: "d11", topic: null, category: "idea", title: null, content: "通勤听播客比听歌状态好，整理一个通勤播客清单" },
  { id: "d12", topic: null, category: "collect", title: "HTTP/3", content: "HTTP/3 基于 QUIC 的握手与拥塞控制改进，值得细读" },
  { id: "d13", topic: null, category: "collect", title: null, content: "https://example.com/article 收藏一篇讲拖延症心理机制的长文" },
  { id: "d14", topic: null, category: "data", title: null, content: "家里 WiFi 信道换到 149 之后测速稳定在 800M" },
  { id: "d15", topic: null, category: "todo", title: null, content: "把阳台的绿萝分盆，顺便买两袋营养土" },
];

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_WORKERS_API_TOKEN;

async function cf(path: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (json.success) return json.result;
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`CF API failed: ${JSON.stringify(json.errors)}`);
  }
}

async function accountId(): Promise<string> {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const res = await fetch(`${API}/accounts`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const json = (await res.json()) as any;
  if (!json.success || !json.result?.[0]?.id) throw new Error("cannot resolve account id");
  return json.result[0].id;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let confirmCalls = 0;
const PROMPT_LOOSE = "判断下面两条想法是否属于同一主题（可以串成同一条思考线索）。是则输出 1，否则输出 0。只输出数字。";
// 严格口径（跨类别/低带候选用）：只看「同一件具体的事」，杂务体裁相似不算
const PROMPT_STRICT =
  "判断下面两条笔记是否在记录同一件具体的事（同一个项目/主题的推进，可以串成同一条线索）。只是体裁相似（都是缴费、都是预约、都是杂务）或泛泛相关不算。是则输出 1，否则输出 0。只输出数字。";
const confirmCache = new Map<string, boolean>();
async function llmConfirmPair(acc: string, a: string, b: string, strict = false): Promise<boolean> {
  const key = `${strict ? "s" : "l"}\u0000${a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`}`;
  const hit = confirmCache.get(key);
  if (hit !== undefined) return hit;
  confirmCalls++;
  const r = await cf(`/accounts/${acc}/ai/run/${CONFIRM_MODEL}`, {
    temperature: 0,
    max_tokens: 10,
    messages: [
      { role: "system", content: strict ? PROMPT_STRICT : PROMPT_LOOSE },
      { role: "user", content: `${strict ? "笔记" : "想法"}A：${a.slice(0, 400)}\n\n${strict ? "笔记" : "想法"}B：${b.slice(0, 400)}` },
    ],
  });
  const yes = parseInt(String(r.response ?? "").trim(), 10) === 1;
  confirmCache.set(key, yes);
  return yes;
}

/** Sequential replay of the production clusterNote decision rule. */
async function simulate(
  acc: string,
  vecs: Map<string, number[]>,
  opts: { eligible: (f: Frag) => boolean; leftoverPass: boolean; strictCross?: boolean }
): Promise<Map<string, string>> {
  // strictCross: pairs where either side is todo/data (the newly-opened pool)
  // and all leftover-pass pairs use the strict "same concrete matter" prompt
  const isStrict = (a: Frag, b: Frag) =>
    Boolean(opts.strictCross) && (a.category === "todo" || a.category === "data" || b.category === "todo" || b.category === "data");
  const threadOf = new Map<string, string>();
  let nextThread = 0;
  const seen: Frag[] = [];
  for (const f of CORPUS) {
    if (!opts.eligible(f)) continue;
    const sims = seen
      .map((p) => ({ frag: p, sim: cosineSim(vecs.get(f.id)!, vecs.get(p.id)!) }))
      .sort((a, b) => b.sim - a.sim);
    let joined: Frag | null = null;
    let how = "";
    if (sims.length > 0 && sims[0].sim >= SIM_JOIN) {
      joined = sims[0].frag;
      how = `direct sim=${sims[0].sim.toFixed(3)}`;
    } else {
      const band = sims.filter((s) => s.sim >= SIM_CONFIRM_FLOOR && s.sim < SIM_JOIN).slice(0, CONFIRM_TOP_K);
      for (const cand of band) {
        if (await llmConfirmPair(acc, f.title || f.content, cand.frag.title || cand.frag.content, isStrict(f, cand.frag))) {
          joined = cand.frag;
          how = `confirmed sim=${cand.sim.toFixed(3)}`;
          break;
        }
      }
    }
    if (joined) {
      let tid = threadOf.get(joined.id);
      if (!tid) {
        tid = `th${nextThread++}`;
        threadOf.set(joined.id, tid);
      }
      threadOf.set(f.id, tid);
      console.log(`  join ${f.id}(${f.category}) -> ${joined.id} (${how})`);
    }
    seen.push(f);
  }
  if (opts.leftoverPass) {
    // leftover pairing: unthreaded eligible notes get an embedding-prescreened
    // LLM-confirmed pairing attempt against other leftovers (sim >= 0.50,
    // top-3, first yes wins) — the cold-start deepseekPickNote path with a
    // vector prescreen instead of no floor at all.
    const leftovers = seen.filter((f) => !threadOf.has(f.id));
    for (const f of leftovers) {
      if (threadOf.has(f.id)) continue;
      const cands = leftovers
        .filter((p) => p.id !== f.id)
        .map((p) => ({ frag: p, sim: cosineSim(vecs.get(f.id)!, vecs.get(p.id)!) }))
        .filter((s) => s.sim >= LEFTOVER_FLOOR && s.sim < SIM_CONFIRM_FLOOR)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, CONFIRM_TOP_K);
      for (const cand of cands) {
        if (await llmConfirmPair(acc, f.title || f.content, cand.frag.title || cand.frag.content, Boolean(opts.strictCross))) {
          let tid = threadOf.get(cand.frag.id);
          if (!tid) {
            tid = `th${nextThread++}`;
            threadOf.set(cand.frag.id, tid);
          }
          threadOf.set(f.id, tid);
          console.log(`  leftover-pair ${f.id}(${f.category}) -> ${cand.frag.id} (sim=${cand.sim.toFixed(3)})`);
          break;
        }
      }
    }
  }
  return threadOf;
}

function score(name: string, threadOf: Map<string, string>) {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    for (let j = i + 1; j < CORPUS.length; j++) {
      const a = CORPUS[i],
        b = CORPUS[j];
      const together = threadOf.get(a.id) !== undefined && threadOf.get(a.id) === threadOf.get(b.id);
      const should = a.topic !== null && a.topic === b.topic;
      if (together && should) tp++;
      else if (together && !should) fp++;
      else if (!together && should) fn++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  // zero-thread topic groups: topics with no thread containing >=2 of its notes
  const topics = [...new Set(CORPUS.filter((f) => f.topic).map((f) => f.topic!))];
  const zero: string[] = [];
  for (const t of topics) {
    const counts = new Map<string, number>();
    for (const f of CORPUS.filter((x) => x.topic === t)) {
      const th = threadOf.get(f.id);
      if (th) counts.set(th, (counts.get(th) ?? 0) + 1);
    }
    if (![...counts.values()].some((c) => c >= 2)) zero.push(t);
  }
  console.log(`\n[${name}]`);
  console.log(`  pair precision=${(precision * 100).toFixed(1)}% (${tp}/${tp + fp})  recall=${(recall * 100).toFixed(1)}% (${tp}/${tp + fn})`);
  console.log(`  zero-thread topic groups: ${zero.length}${zero.length ? ` (${zero.join(",")})` : ""}`);
  console.log(`  confirm calls so far: ${confirmCalls}`);
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

  const catGate = (f: Frag) => f.category === "idea" || f.category === "collect";
  const signalGate = (f: Frag) => f.category !== "expense";

  console.log("=== A: baseline — eligibility = idea/collect (production) ===");
  score("A category gate", await simulate(acc, vecs, { eligible: catGate, leftoverPass: false }));

  console.log("\n=== B: decoupled eligibility — idea/collect/todo/data ===");
  score("B decoupled", await simulate(acc, vecs, { eligible: signalGate, leftoverPass: false }));

  console.log("\n=== C: B + leftover pairing pass (0.50 prescreen + confirm) ===");
  score("C decoupled + leftover pass", await simulate(acc, vecs, { eligible: signalGate, leftoverPass: true }));

  console.log("\n=== D: C + strict confirm for todo/data pairs & leftover pass ===");
  score("D decoupled + leftover + strict cross", await simulate(acc, vecs, { eligible: signalGate, leftoverPass: true, strictCross: true }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
