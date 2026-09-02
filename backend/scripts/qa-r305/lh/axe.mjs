import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const axeSrc = readFileSync(new URL("./node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const browser = await chromium.connectOverCDP("http://localhost:29229");
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const out = {};
for (const [name, path, vp] of [["timeline-desktop", "/", { width: 1280, height: 800 }], ["timeline-375", "/", { width: 375, height: 740 }]]) {
  await page.setViewportSize(vp);
  await page.goto("https://suinian.zalize.com" + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.evaluate(axeSrc);
  const r = await page.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"] }));
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  out[name] = { url: page.url(), overflow, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.html?.slice(0, 140) })) };
  console.log(name, page.url(), "overflow", JSON.stringify(overflow), "violations", out[name].violations.length);
  for (const v of out[name].violations) console.log("  ", v.impact, v.id, v.nodes, v.sample);
}
writeFileSync("../out/axe.json", JSON.stringify(out, null, 1));
await page.close();
await browser.close();
