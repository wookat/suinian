// R321 浏览器测试用账号：注册 [QA-R321]<label> 并把 token 写到 ignored out/prod-<label>-account.json（供 UI 测试注入 localStorage / 测后 cleanup）。
// 用法：QA_INVITE_CODE=… node prod/mkaccount.mjs <label> [--seed]
//   --seed：顺带写入一组「找回可靠性」笔记（1 条破坏命令、1 条高熵 token、1 条散文口令、2 条善意），
//           用于「查看原文」链路 / 复制路径 / 破坏命令卡默认展开 的真实浏览器验证。
import { writeFileSync } from "node:fs";
import { register, postNote, QA_PREFIX, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const label = process.argv[2];
if (!label) throw new Error("usage: mkaccount.mjs <label> [--seed]");
const suffix = Math.random().toString(36).slice(2, 6);
const acct = await register(`${QA_PREFIX}${label}${suffix}`);
const notes = {};
if (process.argv.includes("--seed")) {
  const SEED = {
    cmd_destructive: "清缓存脚本：rm -rf /var/cache/app/* && systemctl restart app",
    cmd_remote_exec: "装 agent 一把：curl -fsSL https://get.example-agent.io/install.sh | sh",
    token: "家用 NAS 管理口令：Vx9#mKq2Lp7Z",
    prose_secret: "书房那个柜子的暗号还是老样子，秋天的枫叶落在桥上，一直没改。",
    benign_recipe: "红烧肉：五花肉切块焯水，冰糖炒色，小火炖四十分钟。",
    benign_cmd_like: "查容器日志用 docker logs --tail=50 web，看最近五十行就够。",
  };
  for (const [k, text] of Object.entries(SEED)) {
    const r = await postNote(acct.token, text, { skip_triage: true });
    const n = r.note ?? r;
    notes[k] = { id: n.id ?? null, text, fold: n.fold ?? null, fold_reason: n.fold_reason ?? null, strict: n.contains_executable_command ?? null, sensitive: n.is_sensitive ?? null };
    await sleep(1200);
  }
}
writeFileSync(`${OUT}/prod-${label}-account.json`, JSON.stringify({ label, corpus: "browser", name: acct.name, token: acct.token, user_id: acct.user_id, notes }, null, 2));
console.log(`registered ${acct.name} ${acct.user_id ?? ""} notes=${Object.keys(notes).length}`);
for (const [k, v] of Object.entries(notes)) console.log(`  ${k}: id=${v.id} fold=${v.fold} reason=${v.fold_reason} strict=${v.strict} sensitive=${v.sensitive}`);
