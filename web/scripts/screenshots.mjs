#!/usr/bin/env node
/**
 * 开发用：把 M2a 的完整流程走一遍并截图，用于自查。
 * 不参与产品运行，也不随构建打包。
 *
 * 用法：node scripts/screenshots.mjs [baseUrl]
 */

import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = process.argv[2] || 'http://127.0.0.1:3100'
const OUT = path.resolve(process.cwd(), '..', 'design', 'preview-m2a')
const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
)

fs.mkdirSync(OUT, { recursive: true })

const shots = []
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`)
  await page.waitForTimeout(opts.wait ?? 900)
  await page.screenshot({ path: file, fullPage: opts.full ?? false })
  const kb = (fs.statSync(file).size / 1024).toFixed(0)
  shots.push(`${name}.png  ${kb} KB`)
  console.log(`  ✓ ${name}.png`)
}

const browser = await chromium.launch({ executablePath: EXEC })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

console.log(`\n截图 → ${OUT}\n`)

/* 1. 总览 */
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot(page, '01-总览-人物')

/* 2. 人物页 */
await page.goto(`${BASE}/p/jingke`, { waitUntil: 'networkidle' })
await shot(page, '02-人物页', { full: true })

/* 3. 故事页 · 情境铺陈 */
await page.goto(`${BASE}/p/jingke/06-yishui`, { waitUntil: 'networkidle' })
await shot(page, '03-情境铺陈', { full: true })

/* 4. 进入 · 第一段 */
await page.click('button.cta')
await shot(page, '04-第一段')

/* 5. 推进到全部段落 */
for (let i = 0; i < 4; i++) {
  await page.click('button.continue')
  await page.waitForTimeout(450)
}
await shot(page, '05-全部段落')

/* 6. 依据面板（默认页签，自动跟随阅读位置） */
await page.click('.beat:first-of-type .ground')
await shot(page, '06-依据面板')

/* 7. 背景卡 */
await page.click('.panel-tabs button:has-text("背景")')
await shot(page, '07-背景卡')

/* 8. 依据映射表 */
await page.click('.panel-tabs button:has-text("映射")')
await shot(page, '08-依据映射表')

/* 9. 原文 */
await page.click('.panel-tabs button:has-text("原文")')
await shot(page, '09-原文')

/* 10. 在场 */
await page.click('.panel-tabs button:has-text("在场")')
await shot(page, '10-在场')

/* 11. 提问面板（回到依据页签） */
await page.click('.panel-tabs button:has-text("依据")')
await page.waitForTimeout(300)
await page.click('.ask-btn')
await shot(page, '11-提问清单')

/* 12. 一条预置回答 */
await page.click('.seed-nav button:has-text("此去心中所想")')
await shot(page, '12-预置回答')

/* 13. 边界外提问（带系统提示） */
await page.click('.seed-nav button:has-text("你知道后来秦灭六国了吗")')
await shot(page, '13-边界外提问')

/* 14. 复习卡（展开一张） */
await page.click('.sheet-head .x')
await page.waitForTimeout(400)
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
await page.waitForTimeout(500)
await page.click('.card button:has-text("点开看答案")')
await shot(page, '14-复习卡')

/* 15. 设置 */
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await shot(page, '15-设置', { full: true })


/* 16+. 八篇弧线：每篇的门口各拍一张。
   篇目从人物页现取，不写死——以后再加故事，这一段自动跟着长。 */
await page.goto(`${BASE}/p/jingke`, { waitUntil: 'networkidle' })
const arcIds = await page.$$eval('a.story-card.ready', (as) =>
  as.map((a) => a.getAttribute('href').split('/').pop())
)
if (!arcIds.length) throw new Error('人物页上一个 .story-card.ready 都没有')
console.log(`\n  ── 弧线 ${arcIds.length} 篇 ──`)

let n = 16
for (const id of arcIds) {
  await page.goto(`${BASE}/p/jingke/${id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await shot(page, `${String(n++).padStart(2, '0')}-弧线-${id}`, { wait: 300 })
}

/* 把最后一篇读进去，收尾 */
await page.click('button.cta')
await page.waitForTimeout(400)
for (let i = 0; i < 2; i++) { await page.click('button.continue'); await page.waitForTimeout(350) }
await shot(page, `${String(n).padStart(2, '0')}-弧线-读完`)

await browser.close()

console.log('\n── 汇总 ──')
shots.forEach((s) => console.log('  ' + s))
if (errors.length) {
  console.log('\n⚠️ 浏览器控制台报错：')
  errors.slice(0, 10).forEach((e) => console.log('  ' + e))
  process.exitCode = 1
} else {
  console.log('\n✓ 无控制台报错\n')
}
