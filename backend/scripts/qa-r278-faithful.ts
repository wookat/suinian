/**
 * R278 忠实性/财务/shell 完整性生产回归脚本（audit-r277 §4/§5 口径）。
 *  - 15 条事实型笔记 × 2 问 = 30 问忠实性（0 幻觉、0「没找到」为过）；
 *  - 财务底账 9 笔：总支出/总收入/结余/最大单笔/Top-3；
 *  - shell 完整性：3 个脚本笔记 × 5 次「完整给我」（间隔 32s），关键 token 全保留为过。
 * 用法：SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/qa-r278-faithful.ts [--out=res.json]
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").replace("--out=", "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 429 && attempt < 6) {
      await sleep(65_000);
      continue;
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

const FACT_NOTES: { content: string; qs: [string, string[]][] }[] = [
  { content: "路由器管理地址是 192.168.31.1，固件版本 3.0.62。", qs: [["路由器管理地址是多少？", ["192.168.31.1"]], ["路由器固件是什么版本？", ["3.0.62"]]] },
  { content: "小区停车月租 450 元，车位号 B2-117。", qs: [["停车月租多少钱？", ["450"]], ["车位号是多少？", ["B2-117"]]] },
  { content: "体检报告：空腹血糖 5.4，总胆固醇 4.9，都在正常范围。", qs: [["空腹血糖是多少？", ["5.4"]], ["总胆固醇是多少？", ["4.9"]]] },
  { content: "驾照到期日 2028-11-03，需提前 90 天换证。", qs: [["驾照什么时候到期？", ["2028"]], ["换证要提前多久？", ["90"]]] },
  // 注：含「密码」的凭据类内容会被生产自动判敏加密，按设计不进问答（audit-r277 §1.2），
  // 忠实性集只放非凭据事实笔记。
  { content: "会议室投影仪支持 HDMI 和 Type-C，遥控器在前台抽屉里。", qs: [["投影仪支持哪些接口？", ["HDMI"]], ["投影仪遥控器在哪里？", ["抽屉"]]] },
  { content: "牙医预约：周四下午 3 点，诊所在建国路 88 号 12 层。", qs: [["牙医预约在什么时候？", ["周四"]], ["诊所地址在哪里？", ["建国路 88"]]] },
  { content: "服务器 cron：每天 02:30 备份数据库，备份保留 14 天。", qs: [["数据库几点备份？", ["02:30"]], ["备份保留多少天？", ["14"]]] },
  { content: "读《置身事内》到第 6 章，讲地方政府投融资。", qs: [["《置身事内》读到第几章？", ["6"]], ["第 6 章讲什么？", ["投融资"]]] },
  { content: "健身计划：每周三次深蹲，工作组 5x5，重量 80kg。", qs: [["深蹲工作组是多少？", ["5"]], ["深蹲重量是多少？", ["80"]]] },
  { content: "毕业论文答辩定在 6 月 12 日上午 9 点，地点主楼 302。", qs: [["答辩是哪天？", ["6 月 12", "6月12"]], ["答辩地点在哪里？", ["302"]]] },
  { content: "空调滤网上次清洗是 3 月 15 日，建议每两个月洗一次。", qs: [["空调滤网多久洗一次？", ["两个月"]], ["滤网上次什么时候洗的？", ["3 月 15", "3月15"]]] },
  { content: "домен example-blog.dev 在 Namecheap 续费到 2027-05-20。", qs: [["博客域名在哪续费的？", ["Namecheap"]], ["域名续费到什么时候？", ["2027"]]] },
  { content: "猫咪疫苗：下一针狂犬疫苗在 9 月 10 日打。", qs: [["猫下一针疫苗是什么时候？", ["9 月 10", "9月10"]], ["下一针是什么疫苗？", ["狂犬"]]] },
  { content: "新买的显示器是 27 寸 4K，刷新率 144Hz。", qs: [["显示器多大尺寸？", ["27"]], ["显示器刷新率多少？", ["144"]]] },
  { content: "高铁票：G1024 次，8 月 30 日 10:05 发车，13 车 7A。", qs: [["高铁几点发车？", ["10:05"]], ["座位号是多少？", ["7A"]]] },
];

const FINANCE_NOTES = [
  "买菜花了 268.50 元",
  "云服务器月费 1560 元",
  "打车 46 元",
  "咖啡 38.5 元",
  "买键盘 799 元",
  "水果 120 元",
  "外卖 89.5 元",
  "地铁充值 100 元",
  "书 253 元",
  "本月工资到账 4060 元",
];
// 支出底账含全部带金额的笔记（事实集的「停车月租 450 元」也是支出）：
// 268.50+1560+46+38.5+799+120+89.5+100+253+450 = 3724.50；收入 4060；结余 335.50
const FINANCE_QS: [string, string[]][] = [
  ["我一共花了多少钱？", ["3724.5", "3,724.5", "3724.50"]],
  ["我一共收入多少钱？", ["4060"]],
  ["最大一笔支出是什么？", ["1560"]],
  ["支出最多的前三笔是哪些？", ["1560", "799", "450"]],
];

const SHELL_NOTES: { content: string; tokens: string[] }[] = [
  {
    content: "备份脚本：\n#!/bin/bash\nset -euo pipefail\ntar czf /backup/data-$(date +%F).tar.gz /var/data\nfind /backup -mtime +14 -delete",
    tokens: ["#!/bin/bash", "set -euo pipefail", "tar czf", "find /backup -mtime +14 -delete"],
  },
  {
    content: "日志清理脚本：\n#!/usr/bin/env bash\nfor f in /var/log/app/*.log; do\n  gzip -9 \"$f\"\ndone",
    tokens: ["#!/usr/bin/env bash", "for f in /var/log/app/*.log; do", "gzip -9", "done"],
  },
  {
    content: "批量重命名脚本：\n#!/bin/bash\nls *.jpeg | while read f; do\n  mv \"$f\" \"${f%.jpeg}.jpg\"\ndone",
    tokens: ["#!/bin/bash", "while read f; do", "mv", "done"],
  },
];

type AskResp = { answer: string; instruction_isolated?: boolean };

async function main() {
  const name = `[QA-R284]faith-${Date.now().toString(36)}`;
  const password = `Qa-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  const reg = await req<{ api_token: string; user?: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  const token = reg.api_token;
  console.log(`registered ${name}${reg.user ? ` user_id=${reg.user.id}` : ""}`);

  for (const n of [...FACT_NOTES.map((x) => x.content), ...FINANCE_NOTES, ...SHELL_NOTES.map((x) => x.content)]) {
    await req("/api/notes", { method: "POST", token, body: JSON.stringify({ content: n }) });
    await sleep(400);
  }
  console.log("notes seeded; waiting 90s for embeddings/triage");
  await sleep(90_000);

  const results: { section: string; q: string; ok: boolean; missing: string[]; answer: string }[] = [];

  async function ask(section: string, q: string, expect: string[]) {
    const r = await req<AskResp>("/api/ask", { method: "POST", token, body: JSON.stringify({ question: q }) });
    const compact = r.answer.replace(/[\s,，]/g, "");
    const missing = expect.filter((e) => !r.answer.includes(e) && !compact.includes(e.replace(/[\s,，]/g, "")));
    results.push({ section, q, ok: missing.length === 0, missing, answer: r.answer });
    console.log(`${missing.length === 0 ? "✓" : "✗"} [${section}] ${q}${missing.length ? ` 缺失 ${missing.join("/")}` : ""}`);
    await sleep(1200);
  }

  for (const n of FACT_NOTES) for (const [q, expect] of n.qs) await ask("faithful", q, expect);
  for (const [q, expect] of FINANCE_QS) await ask("finance", q, expect);

  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < SHELL_NOTES.length; i++) {
      const label = ["备份脚本", "日志清理脚本", "批量重命名脚本"][i];
      const r = await req<AskResp>("/api/ask", {
        method: "POST",
        token,
        body: JSON.stringify({ question: `${label}完整给我` }),
      });
      const missing = SHELL_NOTES[i].tokens.filter((t) => !r.answer.includes(t));
      results.push({ section: "shell", q: `${label}完整给我 #${round + 1}`, ok: missing.length === 0, missing, answer: r.answer });
      console.log(`${missing.length === 0 ? "✓" : "✗"} [shell] ${label} #${round + 1}${missing.length ? ` 缺失 ${missing.join(" | ")}` : ""}`);
      await sleep(32_000);
    }
  }

  const bySection = (s: string) => results.filter((r) => r.section === s);
  const pass = (s: string) => bySection(s).filter((r) => r.ok).length;
  console.log(`\n汇总：忠实性 ${pass("faithful")}/${bySection("faithful").length}；财务 ${pass("finance")}/${bySection("finance").length}；shell ${pass("shell")}/${bySection("shell").length}`);

  await req("/api/auth/me", { method: "DELETE", token });
  const check = await fetch(`${API}/api/auth/me?probe=${Date.now()}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`account deleted; old token status=${check.status}`);

  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, JSON.stringify({ api: API, at: new Date().toISOString(), results }, null, 2));
    console.log(`结果写入 ${OUT}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
