import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://localhost:29229')
const ctx = b.contexts()[0]
const p = await ctx.newPage()
await p.setViewportSize({width:1440,height:900})
const errs = []
p.on('pageerror', e=>errs.push(e.message))
p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()) })
for (const r of ['','todos','threads','reports','settings']) {
  await p.goto(`http://localhost:4173/#/${r}`)
  await p.waitForTimeout(800)
}
await p.fill('#api-base','')
await p.type('#api-base','https://api.example.com:8443/v1')
console.log('url value:', await p.inputValue('#api-base'))
console.log('errors:', errs)
await p.close()
