// R335 追加探针：取消标注后 extractGraph 只看 is_sensitive —— 守值单元的取值会不会变成图谱实体名，
// 进而经 /api/threads/:id graph.entities 与 ask 的 graphTriples 上下文外泄？
// 本地专用（QA_API=http://localhost:8787，本地 register 无需邀请码时传任意 QA_INVITE_CODE）。
// 用法：QA_API=http://localhost:8787 QA_OUT=$PWD/out-local-wai QA_INVITE_CODE=x node prod/graph-probe.mjs
import { req, register, postNote, getNote, setSensitive, ask, sleep, secretHits, J } from "./lib.mjs";

const SECRET = "Hz7mQ2pL9kX3";
const CARRIER = `新家 wifi 那串 ${SECRET}`;
// 同实体（新家 / wifi）的无秘密伴随笔记：让「新家 wifi」问题只需召回它，守值笔记只经图谱 1 跳进入
const MATE = "新家 wifi 装好了，路由器放客厅电视柜上，信号覆盖全屋";

const a = await register("graph");
const out = { user: a.name, steps: [] };
const c = await postNote(a.token, CARRIER);
const m = await postNote(a.token, MATE);
await sleep(8000);
let cn = await getNote(a.token, c.id);
out.steps.push({ step: "seed", carrier_sensitive: cn.is_sensitive, mate_sensitive: (await getNote(a.token, m.id)).is_sensitive });
if (cn.is_sensitive) {
  const r = await setSensitive(a.token, c.id, false);
  out.steps.push({ step: "unmark", status: r.status });
  await sleep(12000);
  cn = await getNote(a.token, c.id);
  out.steps.push({ step: "after_unmark", carrier_sensitive: cn.is_sensitive });
}
// 图谱抽取是 waitUntil 异步；轮询线索图
let hit = null;
for (let i = 0; i < 6 && !hit; i++) {
  await sleep(10000);
  const rb = await req("/api/threads/rebuild", { method: "POST", token: a.token, body: {} });
  await sleep(4000);
  const th = await req("/api/threads", { token: a.token });
  const list = th.json?.threads ?? th.json ?? [];
  for (const t of list) {
    const d = await req(`/api/threads/${t.id}`, { token: a.token });
    const names = (d.json?.graph?.entities ?? []).map((e) => e.name);
    if (names.some((n) => secretHits(n, SECRET).length > 0)) hit = { thread: t.id, entity_names: names, rebuild: rb.status };
  }
  out.steps.push({ step: `threads_poll_${i}`, threads: list.length, hit: !!hit });
}
out.graph_entity_leak = hit;
// ask：关系型问法拉大图谱扩展预算
for (const q of ["新家 wifi 的关系脉络是什么？", "新家路由器放哪、wifi 那串是什么？", "和新家 wifi 相关的实体有哪些？"]) {
  const r = await ask(a.token, q);
  const ans = String(r.json?.answer ?? "");
  out.steps.push({ step: "ask", q, status: r.status, hits: secretHits(ans, SECRET), refs: (r.json?.references ?? []).length, notes_hits: secretHits(JSON.stringify(r.json?.notes ?? []), SECRET), answer: ans.slice(0, 200) });
  await sleep(1500);
}
const del = await req("/api/auth/me", { method: "DELETE", token: a.token });
out.cleanup = { status: del.status, me_after: (await req("/api/auth/me", { token: a.token })).status };
J("graph-probe", out);
console.log(JSON.stringify(out, null, 1));
