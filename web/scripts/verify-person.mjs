#!/usr/bin/env node
// 人物接入验收：检查实际显示的全文、全部卡片/追问与来源，不接触用户浏览器。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { plainSourceText } from '../lib/source-layers.mjs'

const data = JSON.parse(fs.readFileSync(new URL('../data/content.json', import.meta.url)))
const person = data.people.find(p => p.id === process.argv[2])
assert.ok(person, '传入已接入的人物ID，如 yuwentai')
const base = process.env.BASE_URL || 'http://127.0.0.1:3100'
const norm = v => plainSourceText(v).replace(/\s/g, '')
const settle = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const browser = await chromium.launch({ executablePath: `${os.homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` })
const counts = { stories: 0, beats: 0, backgrounds: 0, cards: 0, answers: 0, citations: 0, library: 0 }

try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base)
    // 旧人物记录以真实ID建立在隔离上下文中；新人物操作不能改写这些条目。
    const old = {
      read: { 'caocao/01-wusebang': { beat: 3, beatCount: 7, phase: 'live', done: false, at: 100 }, 'jingke/01-yanwei': { beat: 4, beatCount: 10, phase: 'live', done: false, at: 101 }, 'gaohuan/01-hanshi': { beat: 2, beatCount: 4, phase: 'live', done: false, at: 102 } },
      review: { 'caocao/01-wusebang': { 1: 'known' }, 'jingke/01-yanwei': { 2: 'todo' }, 'gaohuan/01-hanshi': { 1: 'known' } }, last: null,
    }
    await page.evaluate(value => localStorage.setItem('guanshi.progress.v1', JSON.stringify(value)), old)
    await page.reload()
    assert.equal(await page.locator(`a[href="/p/${person.id}"]`).count(), 1, '首页入口重复或仍锁定')
    await page.locator(`a[href="/p/${person.id}"]`).click()
    await page.waitForURL(`${base}/p/${person.id}`)
    assert.equal(await page.locator('.story-card.ready').count(), person.storyList.length)

    async function oldRecordsIntact() {
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1')))
      for (const [key, value] of Object.entries(old.read)) assert.deepEqual(saved.read[key], value)
      for (const [key, value] of Object.entries(old.review)) assert.deepEqual(saved.review[key], value)
    }
    async function citation(id) {
      await page.waitForSelector(`#src-${id} .quote`)
      assert.equal(norm(await page.locator(`#src-${id} .quote`).innerText()), norm(person.source[id].text), `引用${id}原文缺损`)
      counts.citations++
    }
    const entries = person.storyList.filter(s => s.ready)
    for (const [index, entry] of entries.entries()) {
      const story = person.stories[entry.id]
      await page.goto(`${base}/p/${person.id}/${entry.id}`, { waitUntil: 'networkidle' })
      const opening = await page.locator('.opening').innerText()
      for (const line of story.intro.lines) assert.ok(norm(opening).includes(norm(line.text)), `${entry.id} 引入缺失`)
      if (['01-luanjun', '06-shayuan', '13-shenhou'].includes(entry.id)) await page.screenshot({ path: `/tmp/guanshi-${person.id}-opening-${entry.id}-${width}.png` })
      await page.locator('button.cta').click()
      await page.waitForSelector('.reader .beat')
      for (const beat of story.beats) {
        const text = norm(await page.locator(`#beat-${beat.n} .narration`).innerText())
        for (const paragraph of beat.prose) {
          // 引文回译由独立的gloss节点显示，原始段首破折号不是产品内容。
          assert.ok(text.includes(norm(paragraph.replace(/^——/, ''))), `${entry.id}/${beat.n} 正文缺失: ${paragraph}`)
        }
        counts.beats++
        // 每条显式摘句必须可见；展开后仍是原来的完整底本。
        if (beat.sourceExcerpts) {
          const trigger = page.locator(`#beat-${beat.n} .ground`)
          await page.evaluate(n => {
            const beat = document.getElementById(`beat-${n}`)
            window.scrollTo({ top: scrollY + beat.getBoundingClientRect().top - 110, behavior: 'instant' })
          }, beat.n)
          await trigger.click()
          await page.waitForFunction(n => document.querySelector('#source-panel [data-beat]')?.dataset.beat === String(n), beat.n)
          await settle(page)
          for (const [id, excerpt] of Object.entries(beat.sourceExcerpts)) {
            const lead = page.locator('#source-panel .lead').nth(beat.sources.indexOf(id))
            assert.ok(norm(await lead.innerText()).includes(norm(excerpt)), `${entry.id}/${beat.n}/${id} 摘句缺失`)
            assert.ok(norm(await lead.innerText()).includes(norm(person.source[id].origin)), `${id} 出处未显示`)
            const details = lead.locator('details.source-context')
            const summary = details.locator('summary')
            // 先像读者一样滚动旁批内部，避免Playwright自动把整个页面滚到折叠项。
            await summary.evaluate(el => {
              const pane = el.closest('.panel-face')
              pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 25
            })
            await settle(page)
            const pageY = await page.evaluate(() => scrollY)
            await summary.click()
            await settle(page)
            assert.equal(norm(await details.locator('.source-context-text').innerText()), norm(person.source[id].text))
            assert.equal(await page.locator('#source-panel [data-beat]').getAttribute('data-beat'), String(beat.n))
            assert.ok(Math.abs(await page.evaluate(() => scrollY) - pageY) < 3, `${width}px ${entry.id}/${beat.n}/${id}: 展开全文移动正文 ${pageY} -> ${await page.evaluate(() => scrollY)}`)
            await summary.click()
            await settle(page)
            counts.citations++
          }
          await page.keyboard.press('Escape')
          await settle(page)
        }
      }
      const prev = page.locator('.next-bar a.prev'), next = page.locator('.next-bar a.next')
      assert.equal(await prev.count() ? await prev.getAttribute('href') : null, index ? `/p/${person.id}/${entries[index - 1].id}` : null)
      assert.equal(await next.count() ? await next.getAttribute('href') : null, index < entries.length - 1 ? `/p/${person.id}/${entries[index + 1].id}` : null)

      await page.locator('#beat-1 .ground').click()
      await page.locator('.panel-tabs').getByRole('button', { name: '背景', exact: true }).click()
      await settle(page)
      const backgrounds = norm(await page.locator('.panel-body').innerText())
      for (const background of story.backgrounds) {
        assert.ok(backgrounds.includes(norm(background.name)))
        for (const block of background.blocks) {
          if (block.type === 'p') assert.ok(backgrounds.includes(norm(block.text)))
          else for (const cell of [...block.head, ...block.rows.flat()]) assert.ok(backgrounds.includes(norm(cell)))
        }
        counts.backgrounds++
      }
      if (entry.id === '13-shenhou') {
        assert.equal(await page.locator('.panel-body .bg-table tbody tr').count(), 3)
        await page.screenshot({ path: `/tmp/guanshi-${person.id}-background-${width}.png` })
      }
      await page.keyboard.press('Escape')
      await page.locator('.next-bar').scrollIntoViewIfNeeded()
      await page.waitForSelector('.cards .card')
      assert.equal(await page.locator('.cards .card').count(), story.cards.length)
      for (const [i, card] of story.cards.entries()) {
        const article = page.locator('.cards .card').nth(i)
        await article.getByRole('button', { name: /点开看答案/ }).click()
        const shown = norm(await article.innerText())
        assert.ok(shown.includes(norm(card.q)))
        for (const block of card.blocks) {
          if (['p', 'pre'].includes(block.t)) assert.ok(shown.includes(norm(block.v)))
          else for (const cell of [...block.head, ...block.rows.flat()]) assert.ok(shown.includes(norm(cell)))
        }
        const ids = await article.locator('button.cite').allTextContents()
        for (const id of ids.map(v => v.trim()).filter(v => /^\d{3}$/.test(v))) {
          await article.getByRole('button', { name: id, exact: true }).click()
          await citation(id)
          await page.keyboard.press('Escape')
        }
        await article.getByRole('button', { name: i ? '待复习' : '已掌握', exact: true }).click()
        counts.cards++
      }
      await page.locator('.ask-btn').click()
      const dialog = page.getByRole('dialog')
      assert.equal(await dialog.locator('textarea,input').count(), 0)
      for (const seed of story.seeds) {
        await dialog.locator('.seed-nav').getByRole('button', { name: seed.q, exact: true }).click()
        const text = norm(await dialog.locator('.seed-view').innerText())
        for (const paragraph of seed.answer) assert.ok(text.includes(norm(paragraph)))
        const ids = await dialog.locator('.seed-meta .cite').allTextContents()
        for (const id of ids.map(v => v.trim()).filter(v => /^\d{3}$/.test(v))) {
          await dialog.locator('.seed-meta').getByRole('button', { name: id, exact: true }).click()
          assert.equal(norm(await dialog.locator('.seed-citation blockquote').innerText()), norm(person.source[id].text))
          assert.ok(norm(await dialog.locator('.seed-citation p').innerText()).includes(norm(person.source[id].origin)))
          counts.citations++
        }
        counts.answers++
      }
      await page.keyboard.press('Escape')
      await oldRecordsIntact()
      const key = `${person.id}/${story.id}`
      const before = await page.evaluate(key => JSON.parse(localStorage.getItem('guanshi.progress.v1')).review[key], key)
      await page.reload()
      const restored = await page.evaluate(key => JSON.parse(localStorage.getItem('guanshi.progress.v1')).review[key], key)
      assert.deepEqual(restored, before)
      counts.stories++
      console.log(`${width}px ${person.id}/${entry.id}: 全文、背景、复习、追问、来源、跨篇与旧记录通过`)
    }
    await page.goto(`${base}/p/${person.id}/source`, { waitUntil: 'networkidle' })
    for (const [id, source] of Object.entries(person.source)) {
      assert.equal(norm(await page.locator(`#s-${id} .src-text`).innerText()), norm(source.text))
      assert.equal(norm(await page.locator(`#s-${id} .src-gloss`).innerText()), '白话' + norm(person.gloss[id]))
      counts.library++
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await oldRecordsIntact()
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('PASS', JSON.stringify(counts))
} finally {
  await browser.close()
}
