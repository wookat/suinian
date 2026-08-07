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
  category: "idea" | "todo" | "collect" | "data";
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
      const res = await api<{ notes: NoteJson[] }>(`/api/notes?limit=50`);
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
      `\ncategory: ${catOk}/${CASES.length}  todo_due: ${dueOk}/${dueChecked}  tags 无前缀污染: ${tagOk}/${tagChecked}  sensitive: ${sensOk}/${sensChecked}`
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
