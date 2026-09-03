// 复现 faithful30 中单笔记事实问答被整答占位的 3 例：打印 trust_tier / references / 收口计数 / 门禁理由。
import { register, postNote, req, sleep, ask, QA_PREFIX } from "./lib.mjs";

const NOTES = [
  "路由器管理地址是 192.168.31.1，固件版本 3.0.62。",
  "домен example-blog.dev 在 Namecheap 续费到 2027-05-20。",
  "停车月租 450 元，车位号 B2-117。",
];
const QS = ["路由器管理地址是多少？", "路由器固件是什么版本？", "博客域名在哪续费的？", "域名续费到什么时候？", "车位号是多少？"];
const acct = await register(`${QA_PREFIX}rep${Date.now().toString(36).slice(-4)}`);
console.log("registered", acct.name);
try {
  for (const n of NOTES) {
    const r = await postNote(acct.token, n);
    console.log("note", r.note?.id, "fold", r.note?.fold, r.note?.fold_reason, "exec", r.note?.contains_executable_command);
    await sleep(500);
  }
  await sleep(60_000);
  for (const q of QS) {
    const r = await ask(acct.token, q);
    const j = r.json ?? {};
    console.log(`\nQ ${q}\n  status ${r.status} tier=${j.trust_tier} closed=${j.verbatim_closed_spans} isolated=${j.instruction_isolated} gate=${JSON.stringify(j.exec_gate ?? j.guard ?? null)?.slice(0, 300)}`);
    console.log("  refs", (j.notes ?? j.references ?? []).map((n) => `${n.id}:${n.fold ? "fold:" + n.fold_reason : "open"}`).join(" "));
    console.log("  A", JSON.stringify(j.answer));
    await sleep(4200);
  }
} finally {
  const d = await req("/api/auth/me", { method: "DELETE", token: acct.token });
  const c = await req("/api/auth/me", { token: acct.token });
  console.log("deleted", d.status, "old token", c.status);
}
