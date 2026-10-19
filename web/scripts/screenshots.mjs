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

/* 拍谁，从内容里现取，不写死。写死 jingke 的后果是：加到第二个人物时，
   这套截图仍然只拍荆轲，而且不会报错。 */
const DATA = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'data', 'content.json'), 'utf8'))
/* storyList 里只有摘要（id / 篇名 / ready），正文在 person.stories[id]。
   取错层会拿到一个没有 beats 的对象。 */
const READY = DATA.people.flatMap((p) =>
  p.storyList.filter((s) => s.ready)
    .map((s) => ({ person: p, story: p.stories[s.id] }))
    .filter((x) => x.story))
if (!READY.length) throw new Error('data/content.json 里一个已实现的篇目都没有')
const PERSON = READY[0].person
/* 走查用的那篇优先挑「有原文台词」的——那是产品里最复杂的一种形态，
   拿它当样板，缺什么一眼看得出。 */
const WALK = READY.find(({ story }) => story.beats.some((b) => b.quotes?.length)) || READY[0]
const storyRoute = ({ person, story }) => `/p/${person.id}/${story.id}`

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
await page.goto(`${BASE}/p/${PERSON.id}`, { waitUntil: 'networkidle' })
await shot(page, '02-人物页', { full: true })

/* 3. 故事页 · 情境铺陈 */
await page.goto(`${BASE}${storyRoute(WALK)}`, { waitUntil: 'networkidle' })
await shot(page, '03-情境铺陈', { full: true })

/* 4. 进入 · 第一段 */
await page.click('button.cta')
await shot(page, '04-第一段')

/* 5. 连续正文按真实滚动读到结尾，不能把「已渲染全文」当成读完。 */
await page.locator('.next-bar').scrollIntoViewIfNeeded()
await page.waitForSelector('.reader-after')
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
await page.click('.panel-tabs button:has-text("人物")')
await shot(page, '10-在场')

/* 11–14. 提问面板与复习卡。
   种子和复习卡都是**可选件**（`content/README.md`：没有种子就不显示入口）。
   曹操那篇两个都没有，所以这一段必须按内容判断，不能默认存在——
   写死的话，走查到第 11 步就 timeout，而且报的是"找不到 .ask-btn"，
   完全看不出真正的原因是"这一篇本来就没有可问的问题"。 */
const seeds = WALK.story.seeds || []
const cards = WALK.story.cards || []

if (!seeds.length) {
  console.log('  · 这一篇没有对话种子，跳过提问面板（产品里也不显示入口）')
} else {
  await page.keyboard.press('Escape')
  await page.click('.ask-btn')
  await shot(page, '11-提问清单')

  /* 拿内容里的问题当选择器，不写死荆轲那两问。 */
  const normal = seeds.find((s) => !s.sys)
  const bounded = seeds.find((s) => s.sys)
  if (normal) {
    await page.click(`.seed-nav button:has-text(${JSON.stringify(normal.q.slice(0, 10))})`)
    await shot(page, '12-预置回答')
  }
  if (bounded) {
    await page.click(`.seed-nav button:has-text(${JSON.stringify(bounded.q.slice(0, 10))})`)
    await shot(page, '13-边界外提问')
  }
  await page.click('.sheet-head .x')
  await page.waitForTimeout(400)
}

if (!cards.length) {
  console.log('  · 这一篇没有复习卡，跳过（产品里显示「本篇暂无复习卡」）')
} else {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(500)
  await page.click('.card button:has-text("点开看答案")')
  await shot(page, '14-复习卡')
}

/* 15. 设置 */
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' })
await shot(page, '15-设置', { full: true })


/* 16+. 八篇弧线：每篇的门口各拍一张。
   篇目从人物页现取，不写死——以后再加故事，这一段自动跟着长。 */
await page.goto(`${BASE}/p/${PERSON.id}`, { waitUntil: 'networkidle' })
const arcIds = await page.$$eval('a.story-card.ready', (as) =>
  as.map((a) => a.getAttribute('href').split('/').pop())
)
if (!arcIds.length) throw new Error('人物页上一个 .story-card.ready 都没有')
console.log(`\n  ── 弧线 ${arcIds.length} 篇 ──`)

let n = 16
for (const id of arcIds) {
  await page.goto(`${BASE}/p/${PERSON.id}/${id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await shot(page, `${String(n++).padStart(2, '0')}-弧线-${id}`, { wait: 300 })
}

/* 把最后一篇实际滚动读完，收尾。 */
await page.click('button.cta')
await page.waitForTimeout(400)
await page.locator('.next-bar').scrollIntoViewIfNeeded()
await page.waitForSelector('.reader-after')
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
