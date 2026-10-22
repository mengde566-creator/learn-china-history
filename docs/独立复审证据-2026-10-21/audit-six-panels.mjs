#!/usr/bin/env node
// 独立浏览器上下文；不读取、清空或改写用户 Safari 的记录。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
const base = process.env.BASE_URL || 'http://127.0.0.1:3100'
const data = JSON.parse(fs.readFileSync(new URL('../data/content.json', import.meta.url)))
const personId = process.argv.find(arg => arg.startsWith('--person='))?.slice('--person='.length)
const people = data.people.filter(person => ['xiangyu','hanxin','zuti','chenqingzhi','liuyu','xinqiji'].includes(person.id))
assert.ok(people.length, `人物不存在：${personId}`)
const browser = await chromium.launch({ executablePath: `${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` })
let opens = 0
function geometry() {
  const panel = document.querySelector('#source-panel'), pane = panel.getBoundingClientRect()
  const overlaps = []
  for (const area of document.querySelectorAll('.reader .narration')) {
    const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue
      const range = document.createRange(); range.selectNodeContents(walker.currentNode)
      for (const r of range.getClientRects()) {
        if (Math.min(r.right, pane.right) - Math.max(r.left, pane.left) > 2 && Math.min(r.bottom, pane.bottom) - Math.max(r.top, pane.top) > 2) overlaps.push(walker.currentNode.textContent.slice(0, 30))
      }
    }
  }
  return { overlaps, overflow: document.documentElement.scrollWidth > innerWidth, count: document.querySelectorAll('#source-panel').length, inline: !!panel.closest('[data-panel-host]'), pane: pane.toJSON() }
}
const settle = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
try {
  for (const width of (process.argv.includes('--returns') || process.argv.includes('--follow') ? [] : [390, 1324])) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', error => { throw error })
    for (const person of people) for (const entry of person.storyList.filter(s => s.ready)) {
      const story = person.stories[entry.id]
      await page.goto(`${base}/p/${person.id}/${entry.id}`, { waitUntil: 'networkidle' })
      const cta = page.locator('button.cta'); if (await cta.isVisible()) await cta.click()
      for (const beat of story.beats) {
        const trigger = page.locator(`#beat-${beat.n} .ground`)
        await trigger.scrollIntoViewIfNeeded(); await settle(page)
        const before = await trigger.boundingBox()
        const saved = await page.evaluate(() => localStorage.getItem('guanshi.progress.v1'))
        await trigger.click(); await settle(page)
        const g = await page.evaluate(geometry)
        assert.equal(g.count, 1); assert.deepEqual(g.overlaps, [], `${person.id}/${entry.id}/${beat.n}: 正文重叠`)
        assert.equal(g.overflow, false); assert.equal(g.inline, width < 1081)
        if (width < 1081) assert.ok(await page.locator(`#beat-${beat.n} [data-panel-host] #source-panel`).count())
        assert.equal(await page.evaluate(() => localStorage.getItem('guanshi.progress.v1')), saved, '打开查证推进阅读记录')
        if (beat.n === 1) {
          for (const label of ['原文', '背景', '映射', '人物', '依据']) {
            await page.locator('.panel-tabs').getByRole('button', { name: label, exact: true }).click()
            await page.waitForFunction(label => document.querySelector('.panel-tabs [aria-current=true]')?.textContent === label, label)
            await settle(page)
            assert.deepEqual((await page.evaluate(geometry)).overlaps, [])
            assert.ok(await page.locator('.panel-body').innerText())
          }
          if (person.id === 'jingke' && entry.id === '01-yanwei') await page.screenshot({ path: `/tmp/guanshi-panel-final-${width}.png` })
        }
        await page.keyboard.press('Escape'); await settle(page)
        assert.equal(await page.locator('#source-panel').isVisible(), false)
        assert.ok(await trigger.evaluate(el => document.activeElement === el))
        assert.ok(Math.abs((await trigger.boundingBox()).y - before.y) < 3, `${person.id}/${entry.id}/${beat.n} 关闭位置: ${before.y} -> ${(await trigger.boundingBox()).y}`)
        opens++
      }
      console.log(`${width}px ${person.id}/${entry.id}: ${story.beats.length} 段通过`)
    }
    await context.close()
  }
  console.log(`SIX_AUDIT_PANEL_OK ${opens}`)
} finally { await browser.close() }
