/**
 * R112 P1-2 压测：并发同题笔记是否收敛到一条线索。
 *
 * 注册 [QA-R112] 临时账号 → 并发 POST 5 条同主题 idea 笔记 → 轮询 /api/threads
 * 直到收敛或超时 → 注销账号（级联清库）。默认打线上 API。
 *
 * Usage: npx tsx scripts/qa-r112-stress.ts [rounds]
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
let token = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOPICS: string[][] = [
  [
    "[QA-R112] 想做一个帮邻居代收快递的小程序，按件收费",
    "[QA-R112] 代收快递小程序可以加一个到件拍照通知功能",
    "[QA-R112] 快递代收点子：先在自己小区试点，找物业合作",
    "[QA-R112] 代收快递小程序定价想法：普通件一块钱，大件两块",
    "[QA-R112] 快递代收小程序还可以顺带做代扔垃圾的增值服务",
  ],
  [
    "[QA-R112] 周末想去郊区拍星空，查了下光污染地图",
    "[QA-R112] 拍星空需要买个赤道仪，二手的大概八百块",
    "[QA-R112] 星空摄影计划：先用现有镜头试拍银河，8月银心最亮",
    "[QA-R112] 拍星空的地点候选：天文台附近的山头，海拔一千二",
    "[QA-R112] 星空拍摄后期用 Sequator 叠加降噪，教程已收藏",
  ],
];

async function main() {
  const rounds = Math.min(Number(process.argv[2] ?? "2"), TOPICS.length);
  const name = `qa-r112-stress-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Qa!${Math.random().toString(36).slice(2, 10)}A1`;
  const reg = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  token = reg.api_token;
  console.log(`registered ${name} (${reg.user.id})`);

  let allOk = true;
  try {
    for (let round = 0; round < rounds; round++) {
      const contents = TOPICS[round];
      console.log(`\n--- round ${round + 1}: firing ${contents.length} concurrent same-topic notes ---`);
      const results = await Promise.allSettled(
        contents.map((content) => api<{ id: string }>("/api/notes", { method: "POST", body: JSON.stringify({ content }) }))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      console.log(`created ${ok}/${contents.length}`);
      // poll until the async pipeline (triage → cluster → merge) converges
      let threads: { id: string; note_count: number; title: string | null }[] = [];
      // poll past a */10 cron tick so the deferred duplicate sweep gets a shot
      for (let i = 0; i < 90; i++) {
        await sleep(10000);
        const r = await api<{ threads: { id: string; note_count: number; title: string | null }[] }>("/api/threads");
        threads = r.threads;
        const clustered = threads.reduce((s, t) => s + t.note_count, 0);
        console.log(`  t+${(i + 1) * 10}s threads=${threads.length} clustered_notes=${clustered}`);
        if (threads.length === round + 1 && clustered >= (round + 1) * contents.length) break;
      }
      const roundThreads = threads.length - round; // threads from earlier rounds stay
      if (roundThreads === 1) {
        console.log(`round ${round + 1}: CONVERGED to a single thread ✅`);
      } else {
        console.log(`round ${round + 1}: still split into ${roundThreads} threads ❌`);
        for (const t of threads) console.log(`    thread ${t.id} count=${t.note_count} title=${t.title}`);
        allOk = false;
      }
    }
  } finally {
    await api("/api/auth/me", { method: "DELETE" });
    console.log("\ndeleted QA account (cascade removed all data)");
  }
  console.log(allOk ? "\nSTRESS RESULT: PASS" : "\nSTRESS RESULT: FAIL");
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
