// R313：登录态时间线 Lighthouse（移动/桌面）+ axe（桌面/375px）。
// 与 R312 lh.mjs 的差别：不落盘口令（只保存 token，0600），不占用用户可见的 Chrome（自起 headless Chrome，独立 user-data-dir），
// 登录态通过写 localStorage `suinian.settings`（web/src/lib/settings.ts 同款结构）注入，不走密码登录。
// 用法：node prod/lh.mjs [login|run|cleanup]
//  login   注册 [QA-R313]lh-* 账号、写入 13 条普通笔记（含 1 条 broad:code 命令备忘，看 CODE_COPY_HINT 的 a11y）
//  run     起 headless Chrome(CDP 29333) → 注入 token → lighthouse（移动+桌面）与 axe（桌面+375px）
//  cleanup 注销账号并删除本地 token 文件
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { register, postNote, req, sleep, QA_PREFIX } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const LH = new URL("../lh", import.meta.url).pathname;
const ACC = `${OUT}/lh-account.json`;
const WEB = "https://suinian.zalize.com";
const API = "https://suinian-api.zalize.com";
const PORT = 29333;
const CHROME = process.env.CHROME_BIN ?? `${process.env.HOME}/.local/bin/google-chrome`;
const mode = process.argv[2] ?? "run";

const NOTES = [
  "今天读完《穷查理宝典》第三章，芒格讲多元思维模型，记一下感想",
  "买书 ¥52 微信支付 #学习",
  "明天 10 点和设计师过首页改版稿 @todo",
  "跑步 5km 32 分钟，比上周快了 1 分钟",
  "客户反馈搜索结果不够准，需要调权重",
  "周会纪要：Q3 目标聚焦留存，暂缓新功能",
  "午饭 ¥28 支付宝",
  "看到一篇讲 SQLite WAL 模式的文章，收藏 https://sqlite.org/wal.html",
  "给妈妈打电话，她说最近血压稳定了",
  "想法：笔记里的待办自动汇总到每周计划",
  "地铁 ¥4",
  "读《纳瓦尔宝典》：专长 + 杠杆 + 判断力",
  "清理构建缓存：rm -rf node_modules/.cache && npm run build",
];

async function login() {
  if (existsSync(ACC)) return console.log("account exists");
  const acct = await register(`${QA_PREFIX}lh-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(ACC, JSON.stringify({ name: acct.name, token: acct.token, user_id: acct.user_id }), { mode: 0o600 });
  for (const n of NOTES) {
    await postNote(acct.token, n);
    await sleep(400);
  }
  console.log("registered", acct.name, "notes", NOTES.length);
}

async function withChrome(fn) {
  const acct = JSON.parse(readFileSync(ACC, "utf8"));
  const dir = mkdtempSync(`${tmpdir()}/r313-lh-`);
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  try {
    const { chromium } = await import(`${LH}/node_modules/playwright-core/index.mjs`);
    // Lighthouse --port 与 Playwright CDP 会话不能并存（Target closed），每段独立连接/断开。
    const connect = async () => {
      for (let i = 0; i < 20; i++) {
        try { return await chromium.connectOverCDP(`http://localhost:${PORT}`); } catch { await sleep(500); }
      }
      throw new Error("CDP connect failed");
    };
    let browser = await connect();
    let page = await browser.contexts()[0].newPage();
    await page.goto(`${WEB}/`, { waitUntil: "domcontentloaded" });
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), ["suinian.settings", JSON.stringify({ apiBaseUrl: API, apiToken: acct.token, useMock: false, onboarded: true, tourSeen: true })]);
    await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    const cards = await page.locator("#main-content .rounded-xl.border").count();
    console.log("logged in via settings, url", page.url(), "cards", cards);
    await page.close();
    await browser.close();
    await fn({ reconnect: connect });
  } finally {
    chrome.kill("SIGTERM");
    await sleep(500);
    rmSync(dir, { recursive: true, force: true });
  }
}

function lighthouse(name, extra) {
  const outPath = `${OUT}/${name}.json`;
  execFileSync(
    "npx",
    ["lighthouse", `${WEB}/`, `--port=${PORT}`, "--output=json", `--output-path=${outPath}`, "--only-categories=performance,accessibility,best-practices,seo", "--quiet", ...extra],
    { cwd: LH, stdio: "inherit" }
  );
  const d = JSON.parse(readFileSync(outPath, "utf8"));
  const c = d.categories;
  const a = d.audits;
  const ts = a["target-size"];
  const summary = {
    finalUrl: d.finalDisplayedUrl,
    perf: c.performance.score,
    a11y: c.accessibility.score,
    bp: c["best-practices"]?.score,
    seo: c.seo?.score,
    fcp: a["first-contentful-paint"].numericValue,
    lcp: a["largest-contentful-paint"].numericValue,
    tbt: a["total-blocking-time"].numericValue,
    cls: a["cumulative-layout-shift"].numericValue,
    targetSize: { score: ts?.score, items: (ts?.details?.items ?? []).map((i) => i.node?.snippet?.slice(0, 160)) },
    a11yFails: Object.values(a).filter((x) => x.score !== null && x.score < 1 && c.accessibility.auditRefs.some((r) => r.id === x.id)).map((x) => x.id),
  };
  console.log(name, JSON.stringify(summary, null, 1));
  return summary;
}

async function axe(ctx) {
  const axeSrc = readFileSync(`${LH}/node_modules/axe-core/axe.min.js`, "utf8");
  const page = await ctx.newPage();
  const out = {};
  for (const [name, vp] of [["timeline-desktop", { width: 1280, height: 800 }], ["timeline-375", { width: 375, height: 740 }]]) {
    await page.setViewportSize(vp);
    await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.evaluate(axeSrc);
    const r = await page.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    const codeHint = await page.evaluate(() => [...document.querySelectorAll("[data-fold-level]")].map((e) => e.getAttribute("data-fold-level")));
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("button, a, [role=button]")]
        .map((e) => ({ r: e.getBoundingClientRect(), t: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30) }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 24 || x.r.height < 24))
        .map((x) => `${x.t}(${Math.round(x.r.width)}x${Math.round(x.r.height)})`)
    );
    out[name] = { url: page.url(), overflow, foldLevels: codeHint, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.html?.slice(0, 140) })), smallTargets: small };
    console.log(name, page.url(), "overflow", JSON.stringify(overflow), "foldLevels", JSON.stringify(codeHint), "violations", out[name].violations.length, "smallTargets(<24px)", small.length, small.slice(0, 8).join(", "));
    for (const v of out[name].violations) console.log("  ", v.impact, v.id, v.nodes, v.sample);
  }
  writeFileSync(`${OUT}/axe.json`, JSON.stringify(out, null, 1));
  await page.close();
}

async function cleanup() {
  if (!existsSync(ACC)) return console.log("no account file");
  const a = JSON.parse(readFileSync(ACC, "utf8"));
  const me = await req("/api/auth/me", { token: a.token });
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  if (!String(name).startsWith(QA_PREFIX)) return console.log("REFUSE: not QA account", JSON.stringify(name));
  const del = await req("/api/auth/me", { method: "DELETE", token: a.token });
  const after = await req("/api/auth/me", { token: a.token });
  console.log("deleted", name, a.user_id, del.status, "old token after:", after.status);
  unlinkSync(ACC);
}

if (mode === "login") await login();
else if (mode === "cleanup") await cleanup();
else {
  await withChrome(async ({ reconnect }) => {
    const mobile = lighthouse("lh-mobile", []);
    const desktop = lighthouse("lh-desktop", ["--preset=desktop"]);
    const browser = await reconnect();
    await axe(browser.contexts()[0]);
    await browser.close();
    writeFileSync(`${OUT}/lh-summary.json`, JSON.stringify({ mobile, desktop }, null, 1));
  });
}
