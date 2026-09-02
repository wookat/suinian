// R307 P1-5：登录态时间线 Lighthouse（移动/桌面）+ axe（桌面/375px）。
// 用法：node prod/lh.mjs [login|run|cleanup]
//  login   注册 [QA-R308]lh-* 账号（口令运行时随机，仅写 out/lh-account.json，测完删除）、
//          写入 12 条普通笔记，并用 Chrome(CDP 29229) 走产品登录页登录；
//  run     对已登录的 Chrome 跑 lighthouse（移动 + 桌面）与 axe（桌面 + 375px）；
//  cleanup 注销账号并删除本地凭据文件。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { register, postNote, req, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const LH = new URL("../../qa-r305/lh", import.meta.url).pathname;
const ACC = `${OUT}/lh-account.json`;
const WEB = "https://suinian.zalize.com";
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
];

async function login() {
  let acct;
  if (existsSync(ACC)) acct = JSON.parse(readFileSync(ACC, "utf8"));
  else {
    acct = await register(`[QA-R308]lh-${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(ACC, JSON.stringify({ name: acct.name, password: acct.password, token: acct.token }), { mode: 0o600 });
    for (const n of NOTES) {
      await postNote(acct.token, n);
      await sleep(400);
    }
  }
  const { chromium } = await import(`${LH}/node_modules/playwright-core/index.mjs`);
  const browser = await chromium.connectOverCDP("http://localhost:29229");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto(`${WEB}/#/auth`, { waitUntil: "networkidle" });
  const onboarding = page.getByRole("button", { name: /注册新账号/ });
  if (await onboarding.count()) await onboarding.first().click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "登录", exact: true }).first().click();
  await page.fill("#auth-name", acct.name);
  await page.fill("#auth-password", acct.password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.waitForTimeout(4000);
  await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const cards = await page.locator("#main-content .rounded-xl.border").count();
  console.log("logged in as", acct.name, "url", page.url(), "cards", cards);
  await page.close();
  await browser.close();
}

function lighthouse(name, extra) {
  const outPath = `${OUT}/${name}.json`;
  execFileSync(
    "npx",
    ["lighthouse", `${WEB}/`, "--port=29229", "--output=json", `--output-path=${outPath}`, "--only-categories=performance,accessibility,best-practices,seo", "--quiet", ...extra],
    { cwd: LH, stdio: "inherit" }
  );
  const d = JSON.parse(readFileSync(outPath, "utf8"));
  const c = d.categories;
  const a = d.audits;
  const shifts = (a["layout-shifts"] ?? a["layout-shift-elements"])?.details?.items ?? [];
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
    targetSize: { score: ts.score, mode: ts.scoreDisplayMode, items: (ts.details?.items ?? []).map((i) => i.node?.snippet?.slice(0, 160)) },
    shifts: shifts.slice(0, 5).map((i) => ({ score: i.score, node: i.node?.snippet?.slice(0, 160), reasons: i.subItems?.items?.map((s) => s.cause ?? s.extra?.value).slice(0, 3) })),
  };
  console.log(name, JSON.stringify(summary, null, 1));
  return summary;
}

async function axe() {
  const { chromium } = await import(`${LH}/node_modules/playwright-core/index.mjs`);
  const axeSrc = readFileSync(`${LH}/node_modules/axe-core/axe.min.js`, "utf8");
  const browser = await chromium.connectOverCDP("http://localhost:29229");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const out = {};
  for (const [name, vp] of [["timeline-desktop", { width: 1280, height: 800 }], ["timeline-375", { width: 375, height: 740 }]]) {
    await page.setViewportSize(vp);
    await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.evaluate(axeSrc);
    const r = await page.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("button, a, [role=button]")]
        .map((e) => ({ r: e.getBoundingClientRect(), t: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30) }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.width < 24 || x.r.height < 24))
        .map((x) => `${x.t}(${Math.round(x.r.width)}x${Math.round(x.r.height)})`)
    );
    out[name] = { url: page.url(), overflow, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.html?.slice(0, 140) })), smallTargets: small };
    console.log(name, page.url(), "overflow", JSON.stringify(overflow), "violations", out[name].violations.length, "smallTargets(<24px)", small.length, small.slice(0, 8).join(", "));
    for (const v of out[name].violations) console.log("  ", v.impact, v.id, v.nodes, v.sample);
  }
  writeFileSync(`${OUT}/axe.json`, JSON.stringify(out, null, 1));
  await page.close();
  await browser.close();
}

async function cleanup() {
  if (!existsSync(ACC)) return console.log("no account file");
  const a = JSON.parse(readFileSync(ACC, "utf8"));
  const me = await req("/api/auth/me", { token: a.token });
  const name = me.json?.name ?? me.json?.user?.name ?? "";
  if (!String(name).startsWith("[QA-R308]")) return console.log("REFUSE: not QA account", JSON.stringify(name));
  const del = await req("/api/auth/me", { method: "DELETE", token: a.token });
  const after = await req("/api/auth/me", { token: a.token });
  console.log("deleted", name, del.status, "old token after:", after.status);
  unlinkSync(ACC);
}

if (mode === "login") await login();
else if (mode === "cleanup") await cleanup();
else {
  const mobile = lighthouse("lh-mobile", []);
  const desktop = lighthouse("lh-desktop", ["--preset=desktop"]);
  await axe();
  writeFileSync(`${OUT}/lh-summary.json`, JSON.stringify({ mobile, desktop }, null, 1));
}
