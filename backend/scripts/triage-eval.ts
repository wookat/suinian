/**
 * Triage quality regression eval — 10 fixed cases against a live (or local) API.
 *
 * Usage:
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com SUINIAN_TOKEN=xxx npx tsx scripts/triage-eval.ts
 *
 * Creates [QA-EVAL] prefixed notes, waits for async triage, scores
 * category / todo_due / tag-noise expectations, prints accuracy, then
 * deletes every note it created.
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const TOKEN = process.env.SUINIAN_TOKEN ?? "";
if (!TOKEN) {
  console.error("SUINIAN_TOKEN is required");
  process.exit(1);
}

const PREFIX = "[QA-EVAL]";

type NoteJson = {
  id: string;
  content: string;
  category: string | null;
  tags: string[];
  title: string | null;
  todo_due: string | null;
  is_sensitive: boolean;
  amount: number | null;
  currency: string | null;
};

function shanghaiIso(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function nextMondayIso(): string {
  const dow = new Date(Date.now() + 8 * 3600_000).getUTCDay();
  return shanghaiIso((8 - dow) % 7 || 7);
}

function nearestFridayIso(): string {
  const dow = new Date(Date.now() + 8 * 3600_000).getUTCDay();
  return shanghaiIso((5 - dow + 7) % 7);
}

interface EvalCase {
  content: string;
  category: "idea" | "todo" | "collect" | "data" | "expense" | "income";
  /** expected amount (null = amount must be null); undefined = don't check */
  amount?: number | null;
  /** expected currency; only checked when amount is checked */
  currency?: string;
  /** expected due date (YYYY-MM-DD part) or null for "no due"; undefined = don't check */
  due?: string | null;
  /** tags must not contain any of these substrings */
  forbiddenTagParts?: string[];
  /** expected is_sensitive; undefined = don't check */
  sensitive?: boolean;
}

const CASES: EvalCase[] = [
  { content: `${PREFIX} 下周一晚上8点提醒我给客户回邮件`, category: "todo", due: nextMondayIso() },
  { content: `${PREFIX} 明天上午10点半和设计师对 UI 稿`, category: "todo", due: shanghaiIso(1) },
  { content: `${PREFIX} 周五下午3点交季度报告给老板`, category: "todo", due: nearestFridayIso() },
  { content: `${PREFIX} 回头把冰箱滤芯换了`, category: "todo", due: null },
  { content: `${PREFIX} 公司报销流程：先在 OA 提单，再贴发票给财务`, category: "data" },
  // 制度/流程变更但含个人动作（找行政领新版）→ todo（R12 判例）
  { content: `${PREFIX} 9月1号起各部门预算表改用新模板，找行政领新版`, category: "todo" },
  { content: `${PREFIX} https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API 讲 Service Worker 的文档`, category: "collect" },
  { content: `${PREFIX} 突然想到：碎念的周报可以做成邮件推送，让用户被动回顾`, category: "idea" },
  { content: `${PREFIX} 【灵感】给时间流加一个按月折叠的视图`, category: "idea", forbiddenTagParts: ["灵感】", "【"] },
  // R71：[xxx] 样式的前缀标记不得进标签/标题（模拟 issue key / QA 标记等元数据前缀）
  { content: `${PREFIX} [P0] 明天上午修复登录超时的 bug`, category: "todo", due: shanghaiIso(1), forbiddenTagParts: ["P0", "[", "]"] },
  { content: `${PREFIX} 【草稿】落地页首屏文案可以突出 AI 分拣这个卖点`, category: "idea", forbiddenTagParts: ["草稿", "【", "】"] },
  { content: `${PREFIX} 家里 Wi-Fi 密码改成了 hunter2-demo`, category: "data", sensitive: true },
  // R22：技术文档/长文不得误判敏感（模拟文件入库的技术 txt 内容）
  {
    content: `${PREFIX} JWT 认证笔记：access token 短效期（15分钟），refresh token 长效期（7天），刷新时服务端校验 refresh token 后签发新的 access token，客户端存在 httpOnly cookie 里避免 XSS 窃取`, 
    category: "data",
    sensitive: false,
  },
  {
    content: `${PREFIX} 部署文档节选：配置 API key 的步骤——在控制台生成 key 后写入环境变量 SUINIAN_API_KEY，代码里用 process.env 读取，绝不要硬编码。示例：curl -H "Authorization: Bearer <token>" https://api.example.com/v1/notes`,
    category: "data",
    sensitive: false,
  },
  {
    content: `${PREFIX} Python 密码学入门笔记：哈希函数（SHA-256）不可逆，适合存储密码摘要；对称加密（AES-GCM）适合加密数据；非对称（RSA/Ed25519）适合签名与密钥交换。常见错误是自己发明加密算法`,
    category: "data",
    sensitive: false,
  },
  { content: `${PREFIX} 公司 VPN 密码是 Vp2026@qa-demo，账号 qa.tester`, category: "data", sensitive: true },
  // R40：收支记账分拣
  { content: `${PREFIX} 午饭黄焖鸡 23 块`, category: "expense", amount: 23, currency: "CNY" },
  { content: `${PREFIX} 报销到账 1200 元`, category: "income", amount: 1200, currency: "CNY" },
  { content: `${PREFIX} 在 App Store 付了 4.99 美元订阅`, category: "expense", amount: 4.99, currency: "USD" },
  // 金额不确定时不要瞎猜
  { content: `${PREFIX} 今天买了杯咖啡，没看多少钱`, category: "expense", amount: null },
  // 还没发生的花钱是待办，不是支出
  { content: `${PREFIX} 周末记得去买猫粮`, category: "todo" },
  // R108 对抗性敏感语料（R107 P1-1：「密码备忘：」句式漏过预检正则）
  { content: `${PREFIX} 密码备忘：测试站 admin / QaR108!burst`, category: "data", sensitive: true },
  { content: `${PREFIX} 新办宽带账号 gd123456 密码 kd@2026demo`, category: "data", sensitive: true },
  { content: `${PREFIX} 测试环境 token eyJhbGciOiJIUzI1NiJ9.qa.r108demo 先记这`, category: "data", sensitive: true },
  { content: `${PREFIX} 门禁密码换成了 8642，告诉保洁阿姨`, category: "data", sensitive: true },
  // 反例：谈论密码/密钥概念但无真实值，不得误判敏感
  { content: `${PREFIX} 提醒自己：把密码管理器里的旧密码都轮换一遍，开启两步验证`, category: "todo", sensitive: false },
  { content: `${PREFIX} 读书笔记：《密码学与网络安全》讲 TLS 握手时用非对称加密交换会话密钥`, category: "data", sensitive: false },
  // R118 P1：收支方向易混语料（交/付/花/收/退/报销/还/卖）
  { content: `${PREFIX} 吉他课今天交了下半月学费 400 元`, category: "expense", amount: 400, currency: "CNY" },
  { content: `${PREFIX} 付了这个月房租 2600`, category: "expense", amount: 2600, currency: "CNY" },
  { content: `${PREFIX} 给车充电花了 58 块`, category: "expense", amount: 58, currency: "CNY" },
  { content: `${PREFIX} 物业费缴了 1800`, category: "expense", amount: 1800, currency: "CNY" },
  { content: `${PREFIX} 闲鱼卖了旧显示器 350 元`, category: "income", amount: 350, currency: "CNY" },
  { content: `${PREFIX} 上月报销的差旅费 800 到账了`, category: "income", amount: 800, currency: "CNY" },
  { content: `${PREFIX} 退货的鞋退款 269 已收到`, category: "income", amount: 269, currency: "CNY" },
  { content: `${PREFIX} 学生给我交了补课费 300`, category: "income", amount: 300, currency: "CNY" },
  { content: `${PREFIX} 这个月工资发了 15000`, category: "income", amount: 15000, currency: "CNY" },
  // 未发生的交钱是待办不是支出
  { content: `${PREFIX} 月底前记得去交电费`, category: "todo" },
  // R118 P2：外部事件公告不是待办
  { content: `${PREFIX} 沙丘 3 定档 10 月 1 日上映`, category: "data" },
  { content: `${PREFIX} 沙丘 3 十月上映，提醒我提前买票`, category: "todo" },
  { content: `${PREFIX} 闲鱼挂出了显示器，350 出`, category: "idea" },
  // R120 P1-3：资金平移（内转/提现/借入）是 transfer，不是收支
  { content: `${PREFIX} 微信零钱提现 2000 到银行卡`, category: "transfer", amount: 2000, currency: "CNY" },
  { content: `${PREFIX} 转了 5000 到余额宝`, category: "transfer", amount: 5000, currency: "CNY" },
  { content: `${PREFIX} 跟老妈借了 3000 周转`, category: "transfer", amount: 3000, currency: "CNY" },
  // R122 P1-2：借还第三态——归还入账/出账与押金退回都是 transfer，不是收支
  { content: `${PREFIX} 表弟把上次借的 1500 还给我了`, category: "transfer", amount: 1500, currency: "CNY" },
  { content: `${PREFIX} 房东退了押金 3500 到我微信`, category: "transfer", amount: 3500, currency: "CNY" },
  { content: `${PREFIX} 上次借小王的 1000 今天还给他了`, category: "transfer", amount: 1000, currency: "CNY" },
  // R122 D1：消费信贷还款是清偿负债的平移（刷卡时已记 expense）
  { content: `${PREFIX} 还了信用卡 3000`, category: "transfer", amount: 3000, currency: "CNY" },
  { content: `${PREFIX} 花呗上月账单自动扣了 2680`, category: "transfer", amount: 2680, currency: "CNY" },
  // 反例：商家退货退款仍是 income（不被借还/押金规则误伤，语料见上方 R118 组退款条）
  // R120 P2：AA 净额——记自己实际承担的份额，不是垫付总额
  { content: `${PREFIX} 晚饭 AA 一共 480，四个人平摊，我先垫付了`, category: "expense", amount: 120, currency: "CNY" },
  // R194 P2-2：剪藏外壳包裹的无主题词凭证对（R193 6/6 复现）必须判敏感
  {
    content: `${PREFIX} 剪藏含凭证：测试环境后台 admin / Ext-R194-clip-7742\n摘录自内部 wiki 的部署说明片段\nhttps://wiki.example.com/deploy`,
    category: "collect",
    sensitive: true,
  },
  { content: `${PREFIX} 测试环境后台 admin / Sx-R194-mx-77`, category: "data", sensitive: true },
  // 反例：非凭证的斜杠写法不得误判敏感
  { content: `${PREFIX} A/B 测试方案 v2 的分流比例定 50/50`, category: "data", sensitive: false },
  // R194 P1：含退款/负数行的多行台账，金额是带符号列合计
  {
    content: `${PREFIX} 早餐豆浆油条,12.5\n请客吃饭,155\n快递退款,-33.5\n团建烧烤,286.5`,
    category: "expense",
    amount: 420.5,
    currency: "CNY",
  },
  // R120 P2：已敲定的决定是记录不是待办
  { content: `${PREFIX} 公众号选题定了：只写三篇论文精读`, category: "idea" },
  // R108：完成式日志不是待办（R107 P2-3：误标 todo 污染悬而未决）
  { content: `${PREFIX} 今天跑步 7 公里，早上出门凉快多了`, category: "idea" },
  { content: `${PREFIX} 读完《纳瓦尔宝典》第四章，杠杆的三种形式很有启发`, category: "idea" },
  { content: `${PREFIX} 季度报告交了，比截止日提前两天，老板回复说写得不错`, category: "idea" },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 语料里的“明天/周五”期望值按上海时区计算，先把账号时区对齐，
  // 避免 QA 账号默认 UTC 时 due 断言假失败（R118）
  await api("/api/preferences", { method: "PATCH", body: JSON.stringify({ tz: "Asia/Shanghai" }) });
  const created: string[] = [];
  try {
    for (const c of CASES) {
      const { note } = await api<{ note: NoteJson }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ source: "api", raw_type: "text", content: c.content }),
      });
      created.push(note.id);
    }
    console.log(`created ${created.length} notes, waiting for triage...`);

    // poll until every note has a category (max ~90s)
    let notes: NoteJson[] = [];
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      // no q= filter: sensitive notes are stored encrypted, so content LIKE would miss them
      // limit 必须 ≥ 用例数（当前 53），否则最旧的几条永远取不回被误判失败
      const res = await api<{ notes: NoteJson[] }>(`/api/notes?limit=100`);
      notes = res.notes.filter((n) => created.includes(n.id));
      if (notes.length === created.length && notes.every((n) => n.category)) break;
    }

    let catOk = 0;
    let dueChecked = 0;
    let dueOk = 0;
    let tagOk = 0;
    let tagChecked = 0;
    let sensChecked = 0;
    let sensOk = 0;
    let amtChecked = 0;
    let amtOk = 0;
    for (const c of CASES) {
      const n = notes.find((x) => x.content === c.content);
      const cat = n?.category ?? "(unsorted)";
      const catPass = cat === c.category;
      if (catPass) catOk++;
      let line = `${catPass ? "✅" : "❌"} [${cat}${catPass ? "" : ` ≠ ${c.category}`}] ${c.content.slice(0, 40)}`;
      if (c.due !== undefined) {
        dueChecked++;
        const gotDate = n?.todo_due ? n.todo_due.slice(0, 10) : null;
        const duePass = gotDate === c.due;
        if (duePass) dueOk++;
        line += ` | due ${duePass ? "✅" : "❌"} got=${n?.todo_due ?? "null"} want=${c.due ?? "null"}`;
      }
      if (c.amount !== undefined) {
        amtChecked++;
        const gotAmt = n?.amount ?? null;
        const amtPass = gotAmt === c.amount && (c.currency === undefined || (n?.currency ?? null) === (c.amount === null ? null : c.currency));
        if (amtPass) amtOk++;
        else line += ` | amount ❌ got=${gotAmt}${n?.currency ? ` ${n.currency}` : ""} want=${c.amount}${c.currency ? ` ${c.currency}` : ""}`;
      }
      if (c.sensitive !== undefined) {
        sensChecked++;
        const got = n?.is_sensitive === true;
        if (got === c.sensitive) sensOk++;
        else line += ` | sensitive ❌ got=${got} want=${c.sensitive}`;
      }
      const noisy = (n?.tags ?? []).filter((t) =>
        [...(c.forbiddenTagParts ?? []), "QA", "EVAL"].some((p) => t.includes(p))
      );
      tagChecked++;
      if (noisy.length === 0) tagOk++;
      else line += ` | tags 污染 ❌ ${JSON.stringify(noisy)}`;
      console.log(line);
    }
    console.log(
      `\ncategory: ${catOk}/${CASES.length}  todo_due: ${dueOk}/${dueChecked}  tags 无前缀污染: ${tagOk}/${tagChecked}  sensitive: ${sensOk}/${sensChecked}  amount: ${amtOk}/${amtChecked}`
    );
  } finally {
    for (const id of created) {
      await api(`/api/notes/${id}`, { method: "DELETE" }).catch((e) => console.error(`cleanup ${id} failed:`, e));
    }
    console.log(`cleaned up ${created.length} eval notes`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
