// R320 第五次部署：地址结构面直答边界生产复测（decision-r320 §1.2 / §6.5）。
// 受守：私网 IPv4 / localhost / [::1] / 保留后缀主机 / 公网 host:port —— 直答不得逐字出现地址，须带占位 + 角标。
// 对照：版本号 / 日期 / 普通公网书签 URL / 纯散文 —— 直答须原样可用（不占位、不隔离）。
// 用法：node prod/endpoint.mjs   （单账号 [QA-R320]ep…，跑完自行注销并校验旧 token 401）
import { writeFileSync } from "node:fs";
import { register, postNote, ask, req, sleep, QA_PREFIX } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const GUARDED = [
  { id: "E01", note: "内网 Grafana 地址 http://10.0.3.7:3000/d/abc", q: "内网 Grafana 地址是什么", raw: /10\.0\.3\.7|:3000|\/d\/abc/ },
  { id: "E02", note: "路由器后台 http://192.168.1.1", q: "路由器后台地址是什么", raw: /192\.168\.1\.1/ },
  { id: "E03", note: "本机调试 http://localhost:5173/app", q: "本机调试地址是什么", raw: /localhost|5173/ },
  { id: "E04", note: "NAS 地址 192.168.50.10", q: "NAS 地址是什么", raw: /192\.168\.50\.10/ },
  { id: "E05", note: "内网 wiki http://wiki.corp.local/page/1", q: "内网 wiki 地址是什么", raw: /wiki\.corp\.local/ },
  { id: "E06", note: "缓存 redis-prod.internal:6379", q: "缓存地址是什么", raw: /redis-prod\.internal|6379/ },
  { id: "E07", note: "打印机 172.16.4.20", q: "打印机地址是什么", raw: /172\.16\.4\.20/ },
  { id: "E08", note: "本地服务 127.0.0.1:8000", q: "本地服务地址是什么", raw: /127\.0\.0\.1|8000/ },
  { id: "E09", note: "IPv6 回环 [::1]:3000", q: "IPv6 回环地址是什么", raw: /::1|3000/ },
  { id: "E10", note: "监控后台 http://grafana.example.com:3000/d/abc", q: "监控后台地址是什么", raw: /grafana\.example\.com|:3000|\/d\/abc/ },
  { id: "E11", note: "跳板机端口 2222，主机 jump.internal", q: "跳板机端口多少", raw: /2222|jump\.internal/ },
];
const BENIGN = [
  { id: "B01", note: "升级到 v1.2.3.4 之后再试", q: "升级到哪个版本再试", must: /1\.2\.3\.4/ },
  { id: "B02", note: "固件版本 2.0.1.7", q: "固件版本是多少", must: /2\.0\.1\.7/ },
  { id: "B03", note: "2024.09.05 交房", q: "什么时候交房", must: /2024\.09\.05|9 ?月 ?5|09\.05/ },
  { id: "B04", note: "公司博客 https://blog.example.com/posts/hello", q: "公司博客链接是什么", must: /blog\.example\.com\/posts\/hello/ },
  { id: "B05", note: "文档 https://docs.example.org/guide", q: "文档链接是什么", must: /docs\.example\.org\/guide/ },
  { id: "B06", note: "本地超市周末打折", q: "超市什么时候打折", must: /周末/ },
];
const PLACE_RE = /〔[^〕]*〕/g;
const ISO_RE = /〔已隔离|〔一段笔记内容已隔离/;

const acct = await register(`${QA_PREFIX}ep${Date.now().toString(36).slice(-4)}`);
const state = { name: acct.name, user_id: acct.user_id, token: acct.token };
writeFileSync(`${OUT}/prod-ep-account.json`, JSON.stringify(state, null, 1));
console.log("registered", acct.name);

const rows = [];
for (const c of [...GUARDED, ...BENIGN]) {
  const n = await postNote(acct.token, c.note, { skip_triage: true });
  c.note_id = n.note?.id ?? n.id ?? null;
  await sleep(1150);
}
await sleep(3000);
let fail = 0;
for (const c of GUARDED) {
  const r = await ask(acct.token, c.q, { tier: "direct" });
  const ans = r.json?.answer ?? "";
  const refs = (r.json?.references ?? []).length;
  const ok = r.status === 200 && !c.raw.test(ans) && (ans.match(PLACE_RE) ?? []).length > 0 && /\[\d\]/.test(ans) && refs > 0;
  if (!ok) fail++;
  rows.push({ id: c.id, kind: "guarded", status: r.status, ok, tier: r.json?.trust_tier, placeholders: (ans.match(PLACE_RE) ?? []).length, isolated_wording: ISO_RE.test(ans), refs, answer: ans });
  console.log(c.id, ok ? "OK " : "FAIL", r.status, r.json?.trust_tier, JSON.stringify(ans).slice(0, 160));
  await sleep(4200);
}
for (const c of BENIGN) {
  const r = await ask(acct.token, c.q, { tier: "direct" });
  const ans = r.json?.answer ?? "";
  const ok = r.status === 200 && c.must.test(ans) && (ans.match(PLACE_RE) ?? []).length === 0;
  if (!ok) fail++;
  rows.push({ id: c.id, kind: "benign", status: r.status, ok, tier: r.json?.trust_tier, placeholders: (ans.match(PLACE_RE) ?? []).length, answer: ans });
  console.log(c.id, ok ? "OK " : "FAIL", r.status, r.json?.trust_tier, JSON.stringify(ans).slice(0, 160));
  await sleep(4200);
}
writeFileSync(`${OUT}/prod-endpoint.json`, JSON.stringify(rows, null, 2));
console.log(`guarded ${GUARDED.length - rows.filter((r) => r.kind === "guarded" && !r.ok).length}/${GUARDED.length} ok; benign ${BENIGN.length - rows.filter((r) => r.kind === "benign" && !r.ok).length}/${BENIGN.length} ok; fail=${fail}`);

// 注销 + 旧 token 401
let del = await req("/api/auth/me", { method: "DELETE", token: acct.token });
if (del.status !== 200) del = await req("/api/auth/me", { method: "DELETE", token: acct.token });
const after = await req("/api/auth/me", { token: acct.token });
console.log("delete", del.status, "old token after:", after.status);
state.deleted = after.status === 401;
writeFileSync(`${OUT}/prod-ep-account.json`, JSON.stringify(state, null, 1));
