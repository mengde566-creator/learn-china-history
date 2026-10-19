#!/usr/bin/env node
// 独立浏览器上下文；不读取、清空或改写用户 Safari 的记录。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import assert from 'node:assert/strict'
const base = process.env.BASE_URL || 'http://127.0.0.1:3100'
const data = JSON.parse(fs.readFileSync(new URL('../data/content.json', import.meta.url)))
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
    for (const person of data.people) for (const entry of person.storyList.filter(s => s.ready)) {
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
  // 一直开着旁批读全文：不点击各段依据，正文滚动本身必须驱动对应内容。
  if (!process.argv.includes('--returns')) {
    const context = await browser.newContext({ viewport: { width: 1324, height: 900 }, reducedMotion: 'reduce' })
    const p = await context.newPage()
    const compact = value => String(value).replace(/\s/g, '')
    let followed = 0
    for (const person of data.people) for (const entry of person.storyList.filter(s => s.ready)) {
      if (process.argv.includes('--follow') && !['01-wusebang', '04-xingyang', '01-yanwei', '08-weisheng', '09-yubi'].includes(entry.id)) continue
      const story = person.stories[entry.id]
      await p.goto(`${base}/p/${person.id}/${entry.id}`, { waitUntil: 'networkidle' })
      await p.locator('button.cta').click()
      await p.getByRole('button', { name: '查证与背景', exact: true }).click()
      await p.evaluate(() => document.fonts.ready); await settle(p)
      const style = await p.locator('.reader-panel').evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderLeftWidth, gap: getComputedStyle(el.closest('.reader')).columnGap }))
      assert.equal(style.bg, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px'); assert.equal(style.gap, '32px')
      for (const beat of story.beats) {
        await p.evaluate(n => { const el = document.getElementById(`beat-${n}`); window.scrollTo({ top: scrollY + el.getBoundingClientRect().top - 110, behavior: 'instant' }) }, beat.n)
        await p.waitForFunction(n => {
          const el = document.getElementById(`beat-${n}`)
          // 末尾复习区刚挂载时页面会变长；继续滚至目标，不能把首次触底当成已到该段。
          if (Math.abs(el.getBoundingClientRect().top - 110) > 2) window.scrollTo({ top: scrollY + el.getBoundingClientRect().top - 110, behavior: 'instant' })
          return Math.abs(el.getBoundingClientRect().top - 110) < 2 && document.querySelector('#source-panel .panel-face')?.dataset.beat === String(n)
        }, beat.n, { timeout: 3000 }).catch(async error => {
          console.error('联动失败', person.id, entry.id, beat.n, await p.evaluate(() => ({ selected: document.querySelector('#source-panel .panel-face')?.dataset.beat, y: scrollY, tops: [...document.querySelectorAll('.beat')].map(el => [el.dataset.n, el.getBoundingClientRect().top]) })))
          throw error
        })
        await settle(p)
        assert.deepEqual((await p.evaluate(geometry)).overlaps, [])
        const full = person.source[beat.sources[0]]?.text || ''
        const match = String(beat.sourceCell || '').match(/^(\d{3})\s+([\s\S]+)$/)
        const expected = beat.sourceExcerpts?.[beat.sources[0]] || (match?.[1] === beat.sources[0] && compact(full).includes(compact(match[2])) ? match[2] : full)
        const lead = p.locator('#source-panel .lead').first()
        const layered = lead.locator(':scope > .source-layer .source-layer-text')
        const displayed = await layered.count() ? (await layered.allTextContents()).join('') : await lead.innerText()
        assert.ok(compact(displayed).includes(compact(expected)), `${person.id}/${entry.id}/${beat.n} 旁批未对应当前原文`)
        const y = await p.evaluate(() => scrollY)
        await settle(p); assert.equal(await p.evaluate(() => scrollY), y, '更新依据反向拉动正文')
        followed++
      }
      const returnBeat = Math.ceil(story.beats.length / 2)
      await p.evaluate(n => window.scrollTo({ top: scrollY + document.getElementById(`beat-${n}`).getBoundingClientRect().top - 110, behavior: 'instant' }), returnBeat)
      await p.waitForFunction(n => document.querySelector('#source-panel .panel-face')?.dataset.beat === String(n), returnBeat)
      assert.equal(await p.evaluate(key => JSON.parse(localStorage.getItem('guanshi.progress.v1')).read[key].beat, `${person.id}/${entry.id}`), story.beats.length, '回看正文降低了已读进度')
      const paragraph = p.locator(`#beat-${returnBeat} .narration > *`).first()
      const y = (await paragraph.boundingBox()).y
      await p.keyboard.press('Escape'); await settle(p)
      assert.ok(Math.abs((await paragraph.boundingBox()).y - y) < 3, '读到后面关闭却回到最初入口')
      console.log(`滚动联动 ${person.id}/${entry.id}: ${story.beats.length} 段通过`)
    }
    console.log(`滚动联动共 ${followed} 段，不依靠逐段点击依据`)
    await context.close()
  }
  // 首次从引入脚注挂载正文：等字体排版稳定后标题仍可见，返回不产生阅读进度。
  for (const width of [390, 1440]) {
    const p = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    await p.goto(`${base}/p/caocao/01-wusebang`, { waitUntil: 'networkidle' })
    await p.locator('.opening-notes summary').click()
    const cite = p.locator('.opening-notes button.cite').first()
    const id = await cite.innerText()
    const saved = await p.evaluate(() => localStorage.getItem('guanshi.progress.v1'))
    await cite.click(); await p.locator(`#src-${id}`).waitFor({ state: 'visible' })
    await p.evaluate(() => document.fonts.ready); await settle(p)
    await p.waitForFunction(() => { const r = document.querySelector('#source-panel')?.getBoundingClientRect(); return r && r.top >= 55 && r.top < 300 }, null, { timeout: 3000 })
    const pane = await p.locator('#source-panel').boundingBox()
    assert.ok(pane.y >= 55 && pane.y < 300, `${width}px 入口查证标题位置 ${pane.y}`)
    await p.locator(`#src-${id} button.back`).click(); await p.locator('.opening').waitFor(); await settle(p)
    assert.ok(await cite.evaluate(el => document.activeElement === el))
    assert.equal(await p.evaluate(() => localStorage.getItem('guanshi.progress.v1')), saved)
    await p.locator('button.cta').click(); await p.locator('#beat-1 .ground').click()
    await p.locator('.panel-tabs').getByRole('button', { name: '原文', exact: true }).click()
    await p.waitForFunction(() => document.querySelector('.panel-tabs [aria-current=true]').textContent === '原文')
    await settle(p)
    const y = await p.evaluate(() => scrollY)
    await p.locator('.panel-face').evaluate(el => { el.scrollTop = el.scrollHeight })
    assert.equal(await p.evaluate(() => scrollY), y, '原文内部滚动带动正文')
    assert.ok(await p.locator('.panel-face').evaluate(el => el.scrollTop > 0))
    await p.close()
  }
  // 复习卡查证也留在原卡之后，不能跳到很远的故事顶部。
  for (const width of [390, 1440]) {
    const p = await browser.newPage({ viewport: { width, height: 900 } })
    await p.goto(`${base}/p/jingke/08-weisheng`, { waitUntil: 'networkidle' })
    await p.locator('button.cta').click(); await p.locator('.next-bar').scrollIntoViewIfNeeded()
    const card = p.locator('.card').filter({ hasText: '荆轲那一击和高渐离那一击' })
    await card.getByRole('button', { name: /点开看答案/ }).click()
    const cite = card.locator('button.cite').filter({ hasText: '065' }).first()
    await cite.scrollIntoViewIfNeeded(); await settle(p)
    const y = (await cite.boundingBox()).y
    await cite.click(); await settle(p)
    assert.ok(await card.locator('[data-panel-host] #source-panel').count())
    const panel = await p.locator('#source-panel').boundingBox()
    assert.ok(panel.y >= 55 && panel.y < 200)
    await p.locator('#src-065 button.back').click(); await settle(p)
    assert.equal(await p.locator('#source-panel').isVisible(), false)
    assert.ok(Math.abs((await cite.boundingBox()).y - y) < 3)
    assert.ok(await cite.evaluate(el => document.activeElement === el))
    await p.close()
  }
  // 断点、极窄、放大字号、正常动效与打开中调整窗口。
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await p.goto(`${base}/p/caocao/01-wusebang`); await p.locator('button.cta').click()
  await p.locator('#beat-3 .ground').click()
  for (const width of [1081, 1080, 768, 320, 1440]) {
    await p.setViewportSize({ width, height: 900 }); await settle(p)
    const g = await p.evaluate(geometry)
    assert.deepEqual(g.overlaps, []); assert.equal(g.overflow, false); assert.equal(g.inline, width < 1081)
  }
  // 已经读到后面再收窄窗口，不能被最初入口的锚点拉回第一页。
  await p.mouse.move(400, 400); await p.mouse.wheel(0, 1)
  await p.evaluate(() => window.scrollTo({ top: scrollY + document.getElementById('beat-5').getBoundingClientRect().top - 110, behavior: 'instant' }))
  await p.waitForFunction(() => document.querySelector('#source-panel .panel-face')?.dataset.beat === '5')
  const reading = p.locator('#beat-5 .narration > *').first()
  const at = (await reading.boundingBox()).y
  await p.setViewportSize({ width: 1081, height: 900 }); await settle(p); await settle(p)
  assert.ok(Math.abs((await reading.boundingBox()).y - at) < 3, `调整窗口未保留阅读位置：${at} -> ${(await reading.boundingBox()).y}`)
  await p.setViewportSize({ width: 390, height: 900 }); await settle(p)
  assert.ok(await p.locator('#beat-5 [data-panel-host] #source-panel').count(), '窄屏旁批没有跟到当前阅读段')
  await p.setViewportSize({ width: 1440, height: 900 }); await settle(p)
  await p.addStyleTag({content: '.reader .narration{font-size:35px}'}); assert.deepEqual((await p.evaluate(geometry)).overlaps, [])
  await p.close()
  console.log(`通过：${opens}次逐段开关、入口/复习返回、原文内部滚动及断点/字号检查`)
} finally { await browser.close() }
