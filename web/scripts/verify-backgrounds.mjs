#!/usr/bin/env node
// 全量背景的实际显示与引用入口；隔离浏览器，不读取用户 Safari 数据。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { plainSourceText } from '../lib/source-layers.mjs'
import { sourceReferences } from '../lib/cite-ids.mjs'

const data = JSON.parse(fs.readFileSync(new URL('../data/content.json', import.meta.url)))
const base = process.env.BASE_URL || 'http://127.0.0.1:3100'
const norm = text => plainSourceText(text).replace(/\s/g, '')
const settle = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const browser = await chromium.launch({ executablePath: `${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` })
const counts = { stories: 0, backgrounds: 0, paragraphs: 0, tables: 0, references: 0 }
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    const reviews = { 'caocao/01-wusebang': { 1: 'known' }, 'jingke/06-yishui': { 4: 'todo' }, 'gaohuan/01-hanshi': { 1: 'known' }, 'yuwentai/01-luanjun': { 2: 'todo' } }
    await page.evaluate(review => localStorage.setItem('guanshi.progress.v1', JSON.stringify({ read: {}, review, last: null })), reviews)
    for (const person of data.people) for (const entry of person.storyList.filter(story => story.ready)) {
      const story = person.stories[entry.id]
      const label = `${width}px ${person.id}/${entry.id}`
      await page.goto(`${base}/p/${person.id}/${entry.id}`, { waitUntil: 'networkidle' })
      await page.locator('button.cta').click()
      const trigger = page.locator('#beat-1 .ground')
      await trigger.click()
      await page.locator('.panel-tabs').getByRole('button', { name: '背景', exact: true }).click()
      await settle(page)
      const cards = page.locator('.panel-face .mark-block')
      assert.equal(await cards.count(), story.backgrounds.length, `${label} 背景丢卡`)
      for (const [index, bg] of story.backgrounds.entries()) {
        const card = cards.nth(index)
        assert.equal(norm(await card.locator('.hd .label').innerText()), norm(bg.name))
        const texts = await card.locator(':scope > .body').allTextContents()
        assert.ok(!texts.some(text => /^(?:-{3,}|\*{3,}|_{3,})$/.test(text.trim())), `${label}/${bg.name} 把稿件分隔符显示为正文`)
        const expected = bg.blocks.filter(block => block.type === 'p').map(block => block.text)
        if (bg.basis) expected.push(bg.basis)
        assert.deepEqual(texts.map(norm), expected.map(norm), `${label}/${bg.name} 段落或依据缺损`)
        counts.paragraphs += bg.blocks.filter(block => block.type === 'p').length
        const tables = bg.blocks.filter(block => block.type === 'table')
        assert.equal(await card.locator('table').count(), tables.length)
        for (const [tableIndex, expectedTable] of tables.entries()) {
          const table = card.locator('table').nth(tableIndex)
          assert.deepEqual((await table.locator('thead th').allTextContents()).map(norm), expectedTable.head.map(norm))
          assert.equal(await table.locator('tbody tr').count(), expectedTable.rows.length)
          for (const [rowIndex, row] of expectedTable.rows.entries()) assert.deepEqual((await table.locator('tbody tr').nth(rowIndex).locator('td').allTextContents()).map(norm), row.map(norm))
          counts.tables++
        }
        const ids = [...sourceReferences(bg.basis)].map(match => match[1]).filter(id => person.source[id])
        assert.deepEqual((await card.locator('button.cite').allTextContents()).map(text => text.trim()), ids, `${label}/${bg.name} 引用入口不符`)
        counts.references += ids.length
        counts.backgrounds++
      }
      if (entry.id === '06-qingzhou') {
        const target = cards.filter({ has: page.locator('.hd .label', { hasText: '受降之前' }) })
        await target.evaluate(el => {
          const pane = el.closest('.panel-face')
          pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20
        })
        await page.locator('#source-panel').scrollIntoViewIfNeeded()
        await settle(page)
        await page.screenshot({ path: `/tmp/guanshi-separators-background-${width}.png` })
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} 横向溢出`)
      await page.keyboard.press('Escape'); await settle(page)
      assert.equal(await page.locator('#source-panel').isVisible(), false)
      assert.ok(await trigger.evaluate(el => document.activeElement === el), `${label} 关闭后焦点丢失`)
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1')).review), reviews)
      counts.stories++
      console.log(`${label}: ${story.backgrounds.length}张背景完整`)
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('PASS', JSON.stringify(counts))
} finally { await browser.close() }
