/**
 * R132 P1: attribution eval for the "notes outside threads" ratio (audit-r131
 * §3.2 measured 199/550 = 36% on the QA corpus, plus per-topic fragmentation:
 * cooking split into 7 threads).
 *
 * Replays the production frugal backfill decision rule (threads.ts clusterNote
 * with opts.frugal: bge-m3 embedding prescreen, single best candidate,
 * SIM_JOIN=0.76 direct join, SIM_CONFIRM_FLOOR=0.62 + one LLM confirm) over a
 * labeled corpus, and attributes every solo (unthreaded) eligible note to a
 * cause bucket:
 *   - singleton_by_design: distractor with no same-topic mate (correct solo)
 *   - below_floor:  same-topic mates exist but best-overall sim < 0.62
 *   - wrong_best:   best candidate was a different topic (same-topic mate in
 *                   band was skipped because only the single best is tried)
 *   - llm_rejected: best candidate was same-topic and in the confirm band but
 *                   the confirm model said no
 * Also reports threads-per-topic (fragmentation) and pair precision/recall.
 *
 * Policies compared:
 *   A: production frugal rule (single best candidate)
 *   B: top-3 in-band candidates, confirm sequentially, stop at first yes
 *   C: like B with confirm floor 0.58
 *
 * Usage: CLOUDFLARE_API_TOKEN=... npx tsx scripts/thread-recall-eval.ts
 */

const SIM_JOIN = 0.76;
const SIM_CONFIRM_FLOOR = 0.62;
const EMBED_MODEL = "@cf/baai/bge-m3";
const CONFIRM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface Frag {
  id: string;
  topic: string | null; // null = distractor, must stay solo
  title: string | null;
  content: string;
}

// 8 topics × 5-7 notes (phrased with realistic variation so within-topic sim
// spans the direct/confirm/below-floor bands) + 16 distractor one-offs.
const CORPUS: Frag[] = [
  // T1 烹饪/做饭 (7)
  { id: "t1a", topic: "T1", title: null, content: "今天试了低温慢煮鸡胸，65 度一小时，比水煮嫩太多了" },
  { id: "t1b", topic: "T1", title: "红烧肉做法笔记", content: "红烧肉先煸出油再加冰糖炒糖色，最后小火炖 40 分钟收汁" },
  { id: "t1c", topic: "T1", title: null, content: "周末做饭心得：备菜提前一晚切好装盒，下班回来 20 分钟能出两菜一汤" },
  { id: "t1d", topic: "T1", title: null, content: "想法：家里的辣椒油可以自己炼，菜籽油烧到冒烟晾一分钟再泼辣子" },
  { id: "t1e", topic: "T1", title: "意面酱汁公式", content: "意面万能公式：蒜末+橄榄油+煮面水乳化，任何配料都能成酱" },
  { id: "t1f", topic: "T1", title: null, content: "炖汤记录：玉米排骨汤加两片姜就够，炖久了玉米甜味全出来" },
  { id: "t1g", topic: "T1", title: null, content: "煎牛排复盘：厚切一定要先室温回温，大火每面 90 秒再静置五分钟" },
  // T2 力量训练 (6)
  { id: "t2a", topic: "T2", title: null, content: "今天深蹲加到 80kg，膝盖没有不适，下周试 85" },
  { id: "t2b", topic: "T2", title: null, content: "硬拉动作复盘：背没绷紧，第三组开始弓背，重量退回 70 练动作" },
  { id: "t2c", topic: "T2", title: "训练分化调整", content: "把三分化改成推拉腿，每周六练，感觉恢复更好" },
  { id: "t2d", topic: "T2", title: null, content: "增肌期饮食：体重×2 克蛋白质，鸡蛋牛奶鸡胸肉换着来" },
  { id: "t2e", topic: "T2", title: null, content: "健身房观察：卧推架永远有人，改成早上七点去人最少" },
  { id: "t2f", topic: "T2", title: null, content: "肩推卡在 40kg 三个月了，试试超级组和递减组打破平台期" },
  // T3 读书 (6)
  { id: "t3a", topic: "T3", title: "《置身事内》读后", content: "读完《置身事内》，土地财政那章解释了基建扩张的逻辑" },
  { id: "t3b", topic: "T3", title: null, content: "在读《纳瓦尔宝典》，杠杆那节值得反复看：代码和媒体是新时代的杠杆" },
  { id: "t3c", topic: "T3", title: null, content: "读书方法想法：难书先听书过一遍框架，再精读，效率高很多" },
  { id: "t3d", topic: "T3", title: "书单", content: "想读清单：《芯片战争》《埃隆马斯克传》《为什么伟大不能被计划》" },
  { id: "t3e", topic: "T3", title: null, content: "《原则》重读笔记：极度求真和极度透明，关键是把痛苦当信号" },
  { id: "t3f", topic: "T3", title: null, content: "今年读书目标调整：从 30 本降到 15 本，但每本写 500 字笔记" },
  // T4 咖啡 (5)
  { id: "t4a", topic: "T4", title: null, content: "手冲参数记录：15g 粉 225g 水 92 度，三段注水，酸感刚好" },
  { id: "t4b", topic: "T4", title: null, content: "新到的耶加雪菲日晒豆，干香是莓果，冲出来居然有酒感" },
  { id: "t4c", topic: "T4", title: "磨豆机对比", content: "C40 和泰摩栗子对比：C40 细粉少，手冲层次明显干净" },
  { id: "t4d", topic: "T4", title: null, content: "想法：办公室咖啡角可以搞个共享豆仓，每人带一包换着喝" },
  { id: "t4e", topic: "T4", title: null, content: "冷萃试验：1:12 粉水比冷藏 16 小时，比热冲甜感高不少" },
  // T5 育儿 (5)
  { id: "t5a", topic: "T5", title: null, content: "娃最近入睡困难，试了提前一小时调暗灯光，好像有点用" },
  { id: "t5b", topic: "T5", title: null, content: "幼儿园老师说娃在园里不爱说话，周末多约小朋友一起玩试试" },
  { id: "t5c", topic: "T5", title: "辅食记录", content: "第一次加牛肉泥没有过敏，下周可以试鳕鱼" },
  { id: "t5d", topic: "T5", title: null, content: "绘本心得：《猜猜我有多爱你》读了两周，娃开始模仿句式说话了" },
  { id: "t5e", topic: "T5", title: null, content: "带娃出门清单固化：水杯、替换衣、湿巾、小零食、一本绘本" },
  // T6 独立开发副业 (5)
  { id: "t6a", topic: "T6", title: null, content: "副业产品想法：做一个给自由职业者的报价单生成器，小而美" },
  { id: "t6b", topic: "T6", title: null, content: "独立开发定价思考：早期就该收费，哪怕 9 块，免费用户反馈会带偏方向" },
  { id: "t6c", topic: "T6", title: "冷启动渠道", content: "独立产品冷启动：垂直社区发帖、Build in Public、SEO 长尾词三条路" },
  { id: "t6d", topic: "T6", title: null, content: "周末写了报价单工具的原型，导出 PDF 功能比想象的费时间" },
  { id: "t6e", topic: "T6", title: null, content: "副业复盘：上线两周 12 个注册 1 个付费，下一步找 10 个种子用户访谈" },
  // T7 西班牙旅行 (5)
  { id: "t7a", topic: "T7", title: null, content: "十月西班牙行程初想：巴塞罗那三天，圣家堂提前订票傍晚光线最好" },
  { id: "t7b", topic: "T7", title: null, content: "西班牙行程更新：巴塞罗那之后坐火车去马德里，普拉多博物馆排半天" },
  { id: "t7c", topic: "T7", title: "机票价格", content: "查了十月去巴塞罗那的机票，转机比直飞便宜两千但多六小时" },
  { id: "t7d", topic: "T7", title: null, content: "塞维利亚要不要去纠结中：弗拉明戈发源地，但十月还是 30 度" },
  { id: "t7e", topic: "T7", title: null, content: "西班牙攻略补充：餐厅晚上八点半才开门，得把晚饭习惯往后调" },
  // T8 电影 (5)
  { id: "t8a", topic: "T8", title: null, content: "看了《奥本海默》，三小时不觉得长，配乐把紧张感拉满" },
  { id: "t8b", topic: "T8", title: null, content: "《沙丘 2》影评想法：视觉是十年级别的，但节奏比第一部赶" },
  { id: "t8c", topic: "T8", title: "想看片单", content: "想看：《坠落的审判》《可怜的东西》《利益区域》" },
  { id: "t8d", topic: "T8", title: null, content: "重看《教父》发现的细节：开场婚礼戏把所有人物关系都埋好了" },
  { id: "t8e", topic: "T8", title: null, content: "电影院观察：周二半价场人最少，以后大片都约周二" },
  // 干扰项：一次性笔记，正确行为是保持孤点 (16)
  { id: "d01", topic: null, title: null, content: "小区快递柜取件高峰在晚八点，物业可以错峰发取件码" },
  { id: "d02", topic: null, title: null, content: "会议室的白板笔总是没水，放一个归还时自检的笔筒试试" },
  { id: "d03", topic: null, title: null, content: "给阳台的绿萝换个自动滴灌，出差两周就不用麻烦邻居" },
  { id: "d04", topic: null, title: "个税申报", content: "个税专项附加扣除申报截止月底，记得传房租合同" },
  { id: "d05", topic: null, title: null, content: "地铁早高峰第二节车厢人最少，明天试试" },
  { id: "d06", topic: null, title: "猫换粮", content: "猫换粮要七日渐进混合，突然换粮易软便" },
  { id: "d07", topic: null, title: null, content: "牙医预约排到下下周了，洗牙该半年一次别拖" },
  { id: "d08", topic: null, title: null, content: "楼下新开的洗车店办卡五折，但先观察俩月再说" },
  { id: "d09", topic: null, title: "降准解读", content: "央行降准释放流动性，存量房贷利率跟随 LPR 调整" },
  { id: "d10", topic: null, title: null, content: "通勤听播客比听歌状态好，整理一个通勤播客清单" },
  { id: "d11", topic: null, title: null, content: "冰箱冷冻室结霜严重，周末断电除霜顺便清库存" },
  { id: "d12", topic: null, title: "露营装备", content: "露营装备清单：三季帐、充气垫、炉具，新手先租后买" },
  { id: "d13", topic: null, title: null, content: "手机相册 5 万张照片了，开个自动备份再批量清屏截图" },
  { id: "d14", topic: null, title: null, content: "小区团购群的车厘子比超市便宜三成，下次跟一单" },
  { id: "d15", topic: null, title: "HTTP/3", content: "HTTP/3 基于 QUIC 的握手与拥塞控制改进，值得细读" },
  { id: "d16", topic: null, title: null, content: "发现晚上十点后写东西效率最高，把写作时间固定下来" },
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
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
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

type Attribution = "joined" | "singleton_by_design" | "below_floor" | "wrong_best" | "llm_rejected";

/** Sequential replay of the frugal clusterNote rule; topK = in-band candidates tried per note. */
async function simulate(
  acc: string,
  vecs: Map<string, number[]>,
  opts: { topK: number; floor: number }
): Promise<{ threadOf: Map<string, string>; attribution: Map<string, Attribution> }> {
  const threadOf = new Map<string, string>();
  const attribution = new Map<string, Attribution>();
  let nextThread = 0;
  const seen: Frag[] = [];
  for (const f of CORPUS) {
    const sims = seen
      .map((p) => ({ frag: p, sim: cosineSim(vecs.get(f.id)!, vecs.get(p.id)!) }))
      .sort((a, b) => b.sim - a.sim);
    let joined: Frag | null = null;
    let how = "";
    if (sims.length > 0 && sims[0].sim >= SIM_JOIN) {
      joined = sims[0].frag;
      how = `direct sim=${sims[0].sim.toFixed(3)}`;
    } else {
      const band = sims.filter((s) => s.sim >= opts.floor && s.sim < SIM_JOIN).slice(0, opts.topK);
      for (const cand of band) {
        if (await llmConfirmPair(acc, f.title || f.content, cand.frag.title || cand.frag.content)) {
          joined = cand.frag;
          how = `confirmed sim=${cand.sim.toFixed(3)}`;
          break;
        }
      }
      if (!joined) {
        // attribute the miss
        const hasMate = f.topic !== null && seen.some((p) => p.topic === f.topic);
        if (!hasMate) attribution.set(f.id, "singleton_by_design");
        else if (sims[0] && sims[0].sim < opts.floor) attribution.set(f.id, "below_floor");
        else if (band.length > 0 && band.some((c) => c.frag.topic === f.topic)) attribution.set(f.id, "llm_rejected");
        else attribution.set(f.id, "wrong_best");
      }
    }
    if (joined) {
      let tid = threadOf.get(joined.id);
      if (!tid) {
        tid = `th${nextThread++}`;
        threadOf.set(joined.id, tid);
      }
      threadOf.set(f.id, tid);
      attribution.set(f.id, "joined");
      console.log(`  join ${f.id} -> ${joined.id} (${how})`);
    } else if (sims.length > 0) {
      console.log(`  solo ${f.id} (best=${sims[0].frag.id} sim=${sims[0].sim.toFixed(3)} cause=${attribution.get(f.id)})`);
    }
    seen.push(f);
  }
  return { threadOf, attribution };
}

function score(name: string, threadOf: Map<string, string>, attribution: Map<string, Attribution>) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < CORPUS.length; i++) {
    for (let j = i + 1; j < CORPUS.length; j++) {
      const a = CORPUS[i], b = CORPUS[j];
      const together = threadOf.get(a.id) !== undefined && threadOf.get(a.id) === threadOf.get(b.id);
      const should = a.topic !== null && a.topic === b.topic;
      if (together && should) tp++;
      else if (together && !should) fp++;
      else if (!together && should) fn++;
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const solo = CORPUS.filter((f) => !threadOf.has(f.id));
  const buckets: Record<string, number> = {};
  for (const f of solo) {
    const k = attribution.get(f.id) ?? "unknown";
    buckets[k] = (buckets[k] ?? 0) + 1;
  }
  // fragmentation: threads per topic
  const topicThreads = new Map<string, Set<string>>();
  for (const f of CORPUS) {
    if (!f.topic) continue;
    const t = threadOf.get(f.id);
    if (!t) continue;
    if (!topicThreads.has(f.topic)) topicThreads.set(f.topic, new Set());
    topicThreads.get(f.topic)!.add(t);
  }
  const frag = [...topicThreads.entries()].map(([k, v]) => `${k}:${v.size}`).join(" ");
  console.log(`\n[${name}]`);
  console.log(`  pair precision=${(precision * 100).toFixed(1)}% (${tp}/${tp + fp})  recall=${(recall * 100).toFixed(1)}% (${tp}/${tp + fn})`);
  console.log(`  unthreaded=${solo.length}/${CORPUS.length} (${((solo.length / CORPUS.length) * 100).toFixed(1)}%)  causes=${JSON.stringify(buckets)}`);
  console.log(`  threads-per-topic: ${frag}`);
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

  console.log("=== Policy A: production frugal rule (best-1, floor 0.62) ===");
  const a = await simulate(acc, vecs, { topK: 1, floor: SIM_CONFIRM_FLOOR });
  score("A production", a.threadOf, a.attribution);

  console.log("\n=== Policy B: top-3 in-band candidates, floor 0.62 ===");
  const b = await simulate(acc, vecs, { topK: 3, floor: SIM_CONFIRM_FLOOR });
  score("B top-3", b.threadOf, b.attribution);

  console.log("\n=== Policy C: top-3 in-band candidates, floor 0.58 ===");
  const c = await simulate(acc, vecs, { topK: 3, floor: 0.58 });
  score("C top-3 floor 0.58", c.threadOf, c.attribution);

  // Policy D: production join rule + a thread-merge pass extended with the
  // same confirm band (reps at 0.62..0.76 get one LLM confirm; today's
  // mergeDuplicateThreads only folds at >=0.76) — targets fragmentation
  // (multiple threads per topic) without touching the note-join floor.
  console.log("\n=== Policy D: production rule + band-confirm thread merge ===");
  const d = await simulate(acc, vecs, { topK: 1, floor: SIM_CONFIRM_FLOOR });
  // rep = newest note per thread (mirrors mergeDuplicateThreads)
  const threads = new Map<string, Frag[]>();
  for (const f of CORPUS) {
    const t = d.threadOf.get(f.id);
    if (!t) continue;
    if (!threads.has(t)) threads.set(t, []);
    threads.get(t)!.push(f); // CORPUS order = chronological; last = newest
  }
  const tids = [...threads.keys()];
  const parent = new Map<string, string>(tids.map((t) => [t, t]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < tids.length; i++) {
    for (let j = i + 1; j < tids.length; j++) {
      const a2 = threads.get(tids[i])!, b2 = threads.get(tids[j])!;
      const ra = a2[a2.length - 1], rb = b2[b2.length - 1];
      const sim = cosineSim(vecs.get(ra.id)!, vecs.get(rb.id)!);
      if (find(tids[i]) === find(tids[j])) continue;
      const fold =
        sim >= SIM_JOIN ||
        (sim >= SIM_CONFIRM_FLOOR && (await llmConfirmPair(acc, ra.title || ra.content, rb.title || rb.content)));
      if (fold) {
        parent.set(find(tids[j]), find(tids[i]));
        console.log(`  merge ${tids[j]} -> ${tids[i]} (rep sim=${sim.toFixed(3)})`);
      }
    }
  }
  const mergedOf = new Map<string, string>();
  for (const [fid, t] of d.threadOf) mergedOf.set(fid, find(t));
  score("D production + band merge", mergedOf, d.attribution);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
