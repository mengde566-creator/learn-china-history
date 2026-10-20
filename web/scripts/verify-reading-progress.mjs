#!/usr/bin/env node
// 原进度键的真实读写；隔离上下文验证短篇末屏，不触及 Safari 的本地数据。
import assert from 'node:assert/strict'
import os from 'node:os'
import { chromium } from 'playwright-core'
const base = process.env.BASE_URL || 'http://127.0.0.1:3100'
const key = 'caocao/03-chenliu'
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const browser = await chromium.launch({ executablePath: `${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` })
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    const other = { beat: 2, beatCount: 3, phase: 'live', done: false, at: 101 }
    const review = { [key]: { 1: 'known', 9: 'todo' }, 'yuwentai/01-luanjun': { 2: 'known' } }
    await page.evaluate(({ key, other, review }) => localStorage.setItem('guanshi.progress.v1', JSON.stringify({
      read: { [key]: { beat: 6, beatCount: 7, phase: 'live', done: false, at: 100 }, 'yuwentai/01-luanjun': other }, review, last: null,
    })), { key, other, review })
    await page.goto(`${base}/p/caocao/03-chenliu`, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready); await settle(page); await settle(page)
    // 复习区已经可以显示，保存的阅读段仍须保持第6段，而非被改成第7段完成。
    await page.locator('.reader-after').waitFor({ state: 'attached' })
    await settle(page)
    const current = async () => page.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1')))
    let state = await current()
    assert.equal(state.read[key].beat, 6, `${width}px 刷新续读被末段露出推进`)
    assert.equal(state.read[key].done, false, `${width}px 尚在第6段却被标记完成`)
    const original = await page.locator('#beat-6').boundingBox()
    assert.ok(original.y >= 55 && original.y < 600, `${width}px 原段不在可读位置`)
    await page.screenshot({ path: `/tmp/guanshi-progress-restored-${width}.png` })
    await page.locator('#beat-6 .ground').click(); await settle(page)
    await page.keyboard.press('Escape'); await settle(page)
    state = await current()
    assert.equal(state.read[key].beat, 6)
    assert.equal(state.read[key].done, false, '单纯查证触发完读')
    assert.deepEqual(state.review, review)
    assert.deepEqual(state.read['yuwentai/01-luanjun'], other)
    // 滚过末段阅读线之后，原有完读与复习流程仍然成立。
    await page.evaluate(() => window.scrollTo({ top: scrollY + document.getElementById('beat-7').getBoundingClientRect().top - 110, behavior: 'instant' }))
    await page.waitForFunction(key => {
      const read = JSON.parse(localStorage.getItem('guanshi.progress.v1')).read[key]
      return read.beat === 7 && read.done
    }, key)
    await page.evaluate(() => window.scrollTo({ top: scrollY + document.getElementById('beat-5').getBoundingClientRect().top - 110, behavior: 'instant' }))
    await settle(page)
    state = await current()
    assert.equal(state.read[key].beat, 7); assert.equal(state.read[key].done, true, '回看降低已完成进度')
    await page.reload({ waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready); await settle(page); await settle(page)
    state = await current()
    assert.equal(state.read[key].beat, 7); assert.equal(state.read[key].done, true)
    assert.deepEqual(state.review, review); assert.deepEqual(state.read['yuwentai/01-luanjun'], other)
    // 已经展开过读后内容，再从头读，临时展示状态也须回到开篇。
    await page.locator('#beat-7 .ground').click(); await settle(page)
    await page.locator('#source-panel .panel-restart').click()
    await page.locator('.opening .cta').click()
    await page.evaluate(() => document.fonts.ready); await settle(page); await settle(page)
    await page.waitForFunction(key => {
      const read = JSON.parse(localStorage.getItem('guanshi.progress.v1')).read[key]
      return read?.beat === 1 && !read.done
    }, key)
    assert.equal(await page.locator('.reader-after').count(), 0, '从头读沿用了上次的读后展示状态')
    state = await current()
    assert.deepEqual(state.review, review); assert.deepEqual(state.read['yuwentai/01-luanjun'], other)
    assert.deepEqual(errors, [])
    console.log(`${width}px: 未到末段不完读，查证不推进；滚到末段、回看、刷新、从头读及旧复习记录通过`)
    await context.close()
  }
} finally { await browser.close() }
