/**
 * Auth (register/login) e2e smoke — runs against a real browser over CDP.
 *
 * Covers the R61 "registration username dropped keystrokes" report:
 *  1. rapid per-key typing into the username field (no controlled-input races)
 *  2. Chinese IME composition commit (no dropped composed text)
 *  3. full register -> logout -> login round-trip against a live API
 *
 * Usage:
 *   CDP_URL=http://localhost:29229 WEB_BASE=http://localhost:5173 \
 *   API_BASE=https://suinian-api.zalize.com QA_PREFIX=[QA-R62] \
 *   node e2e/auth-smoke.mjs
 *
 * The QA account it registers is deleted (DELETE /api/auth/me) at the end.
 */
import { chromium } from "playwright-core"

const CDP_URL = process.env.CDP_URL ?? "http://localhost:29229"
const WEB_BASE = process.env.WEB_BASE ?? "http://localhost:5173"
const API_BASE = process.env.API_BASE ?? "https://suinian-api.zalize.com"
const QA_PREFIX = process.env.QA_PREFIX ?? "[QA-R62]"

let failures = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` — ${detail}`}`)
  if (!ok) failures++
}

const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0]
const page = await ctx.newPage()
let qaToken = null
try {
  await page.goto(`${WEB_BASE}/#/auth`, { waitUntil: "networkidle" })
  // dismiss the first-visit onboarding overlay so it can't intercept clicks
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("suinian.settings") ?? "{}")
    localStorage.setItem("suinian.settings", JSON.stringify({ ...s, onboarded: true }))
  })
  await page.reload({ waitUntil: "networkidle" })
  await page.waitForSelector("#auth-name")

  // 1. rapid typing: per-keystroke events with zero delay
  const rapid = "quickbrownfox1234_ABC-xyz.789"
  await page.fill("#auth-name", "")
  await page.type("#auth-name", rapid, { delay: 0 })
  const rapidVal = await page.inputValue("#auth-name")
  check("rapid typing keeps every keystroke", rapidVal === rapid, `got "${rapidVal}"`)

  // 2. Chinese IME composition: composition events + insertText commit
  await page.fill("#auth-name", "")
  await page.focus("#auth-name")
  await page.evaluate(() => {
    const el = document.querySelector("#auth-name")
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }))
    el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ceshi" }))
  })
  await page.keyboard.insertText("测试用户中文名")
  await page.evaluate(() => {
    const el = document.querySelector("#auth-name")
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "测试用户中文名" }))
  })
  const imeVal = await page.inputValue("#auth-name")
  check("IME composition commit intact", imeVal === "测试用户中文名", `got "${imeVal}"`)

  // 3. register -> logout -> login round-trip
  const qaName = `${QA_PREFIX}e2e${Date.now().toString(36)}`
  const qaPass = `Qa!${Date.now().toString(36)}pass`
  await page.fill("#auth-base", API_BASE)
  await page.fill("#auth-name", qaName)
  await page.fill("#auth-password", qaPass)
  await page.fill("#auth-password2", qaPass)
  await page.click("button:has-text('注册并开始使用')")
  await page.waitForFunction(() => !window.location.hash.includes("auth"), null, { timeout: 30000 })
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("suinian.settings") ?? "{}").apiToken)
  qaToken = typeof token === "string" && token.length > 0 ? token : null
  check("register succeeds and stores api token", qaToken !== null)

  // logout: clear settings, then login with the same credentials
  await page.evaluate(() => localStorage.setItem("suinian.settings", JSON.stringify({ onboarded: true })))
  await page.goto(`${WEB_BASE}/#/auth?mode=login`, { waitUntil: "networkidle" })
  await page.waitForSelector("#auth-name")
  await page.fill("#auth-base", API_BASE)
  await page.fill("#auth-name", qaName)
  await page.fill("#auth-password", qaPass)
  await page.press("#auth-password", "Enter")
  await page.waitForFunction(() => !window.location.hash.includes("auth"), null, { timeout: 30000 })
  const token2 = await page.evaluate(() => JSON.parse(localStorage.getItem("suinian.settings") ?? "{}").apiToken)
  check("login round-trip returns the same token", token2 === token, "token mismatch or missing")
} finally {
  // cleanup: delete the QA account even if a step above failed
  if (qaToken) {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${qaToken}` },
    }).catch(() => null)
    check("QA account cleanup (DELETE /api/auth/me)", !!res?.ok, `status ${res?.status}`)
  }
  await page.close()
  await browser.close()
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
