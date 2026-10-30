import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
const base = process.argv[2] || 'http://127.0.0.1:3119'
const browser = await chromium.launch({executablePath:path.join(os.homedir(),'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')})
try {
  for (const width of [320,390,1080,1081,1440]) for (const story of ['03-jianghu','05-hanling']) {
    const context = await browser.newContext({viewport:{width,height:900}})
    const page = await context.newPage()
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.addInitScript(() => localStorage.setItem('guanshi.progress.v1', JSON.stringify({read:{'caocao/01-wusebang':{beat:2,done:false}},review:{'caocao/01-wusebang':{'1':'known'}},last:null})))
    await page.goto(`${base}/p/gaohuan/${story}`,{waitUntil:'networkidle'})
    await page.getByRole('button',{name:'进入故事'}).click()
    const person=page.locator('.person-name-trigger').first()
    await person.waitFor()
    const prose=await page.locator('#beat-1 .narration').innerText()
    await page.locator('#beat-1 .ground').click()
    await page.locator('#source-panel .panel-face').waitFor()
    await page.locator('#source-panel .cite').first().click()
    await page.waitForSelector('#source-panel .cite.back')
    assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'原文')
    await person.click();await page.waitForSelector('.person-note-return')
    assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'人物')
    const info=await page.locator('#story-person-erzhu-zhao .person-note-text > p').innerText()
    assert.match(info,/尔朱兆/);assert.ok(!/自缢|败走/.test(info))
    if(story==='05-hanling') {
      const other=page.locator('.person-name-trigger').filter({hasText:'尔朱荣'}).first();await other.click()
      assert.match(await page.locator('#story-person-erzhu-rong .person-note-text > p').innerText(),/孝庄帝/)
      assert.equal(await page.locator('#story-person-erzhu-rong').getAttribute('data-person-current'),'true')
      const entry=page.locator('#story-person-erzhu-rong')
      await entry.locator('summary').click()
      const citation=entry.locator('button.cite').first()
      const citationText=await citation.innerText()
      await citation.click()
      assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'原文')
      await page.locator('#source-panel .cite.back').first().click()
      await page.waitForTimeout(100)
      assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'人物')
      assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),citationText.trim())
    }
    await page.locator('.person-note-return').click();await page.waitForTimeout(150)
    assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'原文')
    assert.ok(await person.evaluate(e=>e===document.activeElement))
    await page.locator('#source-panel .cite.back').first().click();await page.waitForTimeout(150)
    assert.equal(await page.locator('#source-panel .panel-tabs button[aria-current="true"]').innerText(),'依据')
    assert.equal(await page.locator('#beat-1 .narration').innerText(),prose)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    const saved=JSON.parse(await page.evaluate(()=>localStorage.getItem('guanshi.progress.v1')))
    assert.equal(saved.review['caocao/01-wusebang']['1'],'known')
    assert.equal(saved.read['caocao/01-wusebang'].beat,2)
    assert.deepEqual(errors,[])
    console.log(`通过 ${width} ${story}`)
    await context.close()
  }
} finally {await browser.close()}
