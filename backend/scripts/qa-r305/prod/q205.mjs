// q205 稳定性探针：固定 history（ask-eval-data q205 原文），重复 N 次调用 /api/ask，
// 记录 finance_subset / finance_list_follow_up / finance_fail_closed 标志与答案首行，
// 判断「分别是哪几笔？」关键词继承是否确定性。账号无笔记 → 确定性路径应为
// 子集零命中（finance_subset+finance_fail_closed），落全量列举（你共记了）即漂移。
import { register, req, sleep } from "./lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(OUT, { recursive: true });
const N = parseInt(process.env.N ?? "10", 10);
const history = [
  { role: "user", content: "今年买书一共花了多少" },
  {
    role: "assistant",
    content:
      "按关键词「买书」精确匹配（标题/正文/标签），今年共 1 笔支出：\n- CNY：支出 ¥52\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。",
  },
];

const acct = await register(`[QA-R305]q205-${Math.random().toString(36).slice(2, 8)}`);
console.log("account", acct.name, acct.user_id);
const rows = [];
try {
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    let r = await req("/api/ask", { method: "POST", token: acct.token, body: { question: "分别是哪几笔？", history } });
    if (r.status === 429) {
      await sleep(30000);
      r = await req("/api/ask", { method: "POST", token: acct.token, body: { question: "分别是哪几笔？", history } });
    }
    const j = r.json ?? {};
    const row = {
      i,
      status: r.status,
      ms: Date.now() - t0,
      finance_subset: j.finance_subset ?? null,
      finance_list_follow_up: j.finance_list_follow_up ?? null,
      finance_fail_closed: j.finance_fail_closed ?? null,
      refs: (j.references ?? []).length,
      head: (j.answer ?? r.text ?? "").split("\n")[0].slice(0, 80),
      server_timing: r.headers.get("server-timing"),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await sleep(1500);
  }
} finally {
  const del = await req("/api/auth/me", { method: "DELETE", token: acct.token });
  console.log("delete", del.status);
  writeFileSync(join(OUT, "q205-stability.json"), JSON.stringify({ account: acct.name, user_id: acct.user_id, rows }, null, 2));
}
