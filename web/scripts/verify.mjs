#!/usr/bin/env node
/**
 * 浏览器端验证套件。
 *
 * 为什么要有这个文件：
 *
 *   做上面那些改动时，我写了七八个一次性脚本（`scripts/_xxx.mjs`），
 *   跑完就删。结果是**验证方法没有沉淀**——下次要测同样的东西，
 *   还得从零再写一遍，而且很容易写出错的探针（我写错过两次：
 *   一次拿不同字的宽度比"字体是否覆盖"，一次探针等待时间不够误报 bug）。
 *
 *   所以把方法固化在这里。加一项检查就加一个 `check(...)`。
 *
 * 前提：服务器已经在跑（npm run dev 或 npm start）。
 * 用法：
 *   npm run verify              全部检查
 *   npm run verify -- contrast  只跑名字里含 contrast 的
 */
import { chromium } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3100'
const CHROME = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
)
const FILTER = process.argv.slice(2).find((a) => !a.startsWith('-'))

/* ── 页面清单从内容里现取，不写死 ──────────────────
   写死 jingke 的后果不是报错，是**静默地少查**：加到第二个人物时，
   这些检查仍然只跑荆轲，而输出看起来一切正常。
   所以人物、篇目、路由全部由 data/content.json 推出来。 */
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'content.json'), 'utf8'))
const PEOPLE = DATA.people
/* storyList 里只有摘要（id / 篇名 / ready），正文在 person.stories[id]。
   取错层会拿到一个没有 beats 的对象。 */
const READY = PEOPLE.flatMap((p) =>
  p.storyList.filter((s) => s.ready)
    .map((s) => ({ person: p, story: p.stories[s.id] }))
    .filter((x) => x.story))
const routeOf = ({ person, story }) => `/p/${person.id}/${story.id}`

const ROUTES = [
  '/', '/settings',
  ...PEOPLE.map((p) => `/p/${p.id}`),
  ...READY.map(routeOf),
]
/* 挑样本时优先用「有原文台词」和「铺陈不带内联标记」的篇目——
   这两种是最容易出问题、也最值得盯的形态。没有就退回第一篇。 */
const firstWith = (pred, fallback) => READY.find(pred) || fallback
const SAMPLE = {
  person: READY[0].person,
  story: READY[0].story,
  quoted: firstWith(({ story }) => story.beats.some((b) => b.quotes?.length), READY[0]),
  bare: firstWith(({ story }) => story.intro?.lines?.some((l) => !l.marker), READY[0]),
}
const sampleRoute = (which) => routeOf(SAMPLE[which])

/* ── 收集器 ─────────────────────────────────────── */

const results = []
let browser
let page

const check = (name, fn) => results.push({ name, fn })

function ok(msg) { return { pass: true, msg } }
function fail(msg) { return { pass: false, msg } }

/**
 * WCAG 对比度，**函数形式**传进 page.evaluate。
 * 不要用 eval(字符串)——那不会在页面里产生作用域绑定。
 */
function wcagInPage() {
  const lum = (c) => {
    const m = c.match(/[\d.]+/g).map(Number)
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2])
  }
  const contrast = (a, b) => {
    const [hi, lo] = [Math.max(a, b), Math.min(a, b)]
    return +((hi + 0.05) / (lo + 0.05)).toFixed(2)
  }
  /** 往上找第一个不透明的背景色。
      故事行的 background-color 是 transparent（纸在父元素 .story-list 上），
      直接读行自己的背景会拿到 rgba(0,0,0,0)。 */
  const effectiveBg = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor
      if (c && !/^rgba?\(0,\s*0,\s*0,\s*0\)$|^transparent$/.test(c)) return c
      n = n.parentElement
    }
    return getComputedStyle(document.body).backgroundColor
  }
  return { lum, contrast, effectiveBg }
}

/**
 * 浅色模式全站扫一遍，返回低于地板的文字。
 *
 * 两件事和 wcagInPage 不同，都是被坑出来的：
 *  1. color-mix() 算出来是 color(srgb r g b / a)，三个分量是 0–1 浮点。
 *     用 /[\d.]+/g 抓会当成 0–255 读，得到一个近乎全黑的假背景——
 *     我据此误判过导航文字"对比度只有 2.37"。
 *  2. 半透明背景必须逐层合成。导航是 color-mix(... 88%, transparent)，
 *     只看自己不合成，拿到的不是真实底色。
 * 这个函数整段跑在页面里，所以直接传给 page.evaluate，不走 new Function。
 */
function lightScanInPage() {
  const parse = (s) => {
    s = String(s).trim()
    const cs = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/)
    if (cs) return [+cs[1] * 255, +cs[2] * 255, +cs[3] * 255, cs[4] === undefined ? 1 : +cs[4]]
    const n = (s.match(/[\d.]+/g) || []).map(Number)
    if (s.startsWith('rgb(')) return [n[0], n[1], n[2], 1]
    if (s.startsWith('rgba(')) return [n[0], n[1], n[2], n[3] === undefined ? 1 : n[3]]
    return null
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const over = (fg, bg) => { const a = fg[3]; return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))) }
  const effBg = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const p = parse(getComputedStyle(n).backgroundColor)
      if (p) {
        if (p[3] > 0.95) return p.slice(0, 3)
        if (p[3] > 0) return over(p, effBg(n.parentElement))
      }
      n = n.parentElement
    }
    const b = parse(getComputedStyle(document.body).backgroundColor)
    return b ? b.slice(0, 3) : [255, 255, 255]
  }
  const FLOOR = 2.8
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
    if (!txt) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const fg = parse(cs.color)
    if (!fg) continue
    const bg = effBg(el)
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    const ratio = +(((hi + 0.05) / (lo + 0.05)).toFixed(2))
    if (ratio >= FLOOR) continue
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : ''
    out.push({ ratio, sel: el.tagName.toLowerCase() + cls, txt: txt.slice(0, 14), color: cs.color, size: cs.fontSize })
  }
  const seen = new Map()
  for (const w of out) if (!seen.has(w.sel) || seen.get(w.sel).ratio > w.ratio) seen.set(w.sel, w)
  return [...seen.values()].sort((a, b) => a.ratio - b.ratio).slice(0, 5)
}

/** 开一个干净的页面，收集控制台错误。
 *  opts 透传给 newPage——只给需要它的检查：reducedMotion 会把过渡压成瞬时，
 *  量到的才是落定色；但动效那条检查恰恰要看动画，所以不能全局开。 */
async function open(mode = 'dark', opts = {}) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...opts })
  p.__errors = []
  p.on('pageerror', (e) => p.__errors.push(String(e).slice(0, 200)))
  p.on('console', (m) => { if (m.type() === 'error') p.__errors.push(m.text().slice(0, 200)) })
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 15000 })
  await p.evaluate((m) => {
    localStorage.setItem('guanshi.settings.v1', JSON.stringify({ aiEnabled: false, lightStage: m === 'light' }))
  }, mode)
  return p
}

/* ── 检查项 ─────────────────────────────────────── */

check('routes: 所有路由可访问且无控制台报错', async () => {
  const bad = []
  for (const r of ROUTES) {
    const res = await page.goto(`${BASE}${r}`, { waitUntil: 'networkidle' })
    if (res.status() !== 200) bad.push(`${r} → HTTP ${res.status()}`)
    if (page.__errors.length) bad.push(`${r} → 控制台: ${page.__errors[0]}`)
    page.__errors = []
  }
  return bad.length ? fail(bad.join('；')) : ok(`${ROUTES.length} 个路由全部 200，无报错`)
})

check('contrast: 纸面卡上的文字（暗场）', async () => {
  await page.goto(`${BASE}/p/${SAMPLE.person.id}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const r = await page.evaluate((getTools) => {
    const { lum, contrast, effectiveBg } = new Function('return (' + getTools + ')()')()
    const card = document.querySelector('.story-card.ready')
    if (!card) return null
    const bg = lum(effectiveBg(card))
    const out = {}
    for (const [k, sel] of [['情境', '.q'], ['篇名', '.nm'], ['元信息', '.mt']]) {
      out[k] = contrast(lum(getComputedStyle(card.querySelector(sel)).color), bg)
    }
    return out
  }, wcagInPage.toString())
  if (!r) return fail('找不到故事卡')
  const bad = Object.entries(r).filter(([, v]) => v < 4.5)
  return bad.length
    ? fail(bad.map(([k, v]) => `${k} ${v}:1（要求 ≥4.5）`).join('；'))
    : ok(Object.entries(r).map(([k, v]) => `${k} ${v}:1`).join('　'))
})

check('contrast: 纸面卡上的文字（浅色模式）', async () => {
  const p = await open('light')
  await p.goto(`${BASE}/p/${SAMPLE.person.id}`, { waitUntil: 'networkidle' })
  await p.evaluate(() => document.fonts.ready)
  const r = await p.evaluate((getTools) => {
    const { lum, contrast, effectiveBg } = new Function('return (' + getTools + ')()')()
    const card = document.querySelector('.story-card.ready')
    const bg = lum(effectiveBg(card))
    return { 情境: contrast(lum(getComputedStyle(card.querySelector('.q')).color), bg) }
  }, wcagInPage.toString())
  await p.close()
  return r.情境 < 4.5 ? fail(`情境 ${r.情境}:1（要求 ≥4.5）`) : ok(`情境 ${r.情境}:1`)
})

/* 门口的「逐行依据」卡落在暗场上，但复用的是纸面 .mark-block 的形状。
   纸面 .body 写死 #4e4840，在 --xuan-2 上只有 1.91:1——肉眼几乎看不见。
   这条守的就是那次覆盖，用 01（依据只在这张表里，没有内联标记）当最坏样本。 */
check('contrast: 门口的逐行依据卡（暗场）', async () => {
  await page.goto(`${BASE}${sampleRoute('bare')}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const r = await page.evaluate((getTools) => {
    const { lum, contrast, effectiveBg } = new Function('return (' + getTools + ')()')()
    const box = document.querySelector('.note-box')
    const row = box && box.querySelector('.mark-block')
    if (!row) return null
    const bg = lum(effectiveBg(box))
    return {
      条数: box.querySelectorAll('.mark-block').length,
      行名: contrast(lum(getComputedStyle(row.querySelector('.label')).color), bg),
      依据: contrast(lum(getComputedStyle(row.querySelector('.body')).color), bg),
      标记: contrast(lum(getComputedStyle(row.querySelector('.src')).color), bg),
    }
  }, wcagInPage.toString())
  if (!r) return fail('找不到 .note-box .mark-block——情境铺陈的逐行依据卡没渲染出来')
  if (!r.条数) return fail('逐行依据卡是空的')
  const bad = []
  for (const k of ['行名', '依据']) if (r[k] < 4.5) bad.push(`${k} ${r[k]}:1（要求 ≥4.5）`)
  // 标记字形是语义色（◆朱 / ○苍），全站暗场既有值就是 3.13:1，按非文字对比度 1.4.11 取 3 为地板
  if (r.标记 < 3) bad.push(`标记 ${r.标记}:1（要求 ≥3）`)
  return bad.length
    ? fail(bad.join('；'))
    : ok(`${r.条数} 条　行名 ${r.行名}:1　依据 ${r.依据}:1　标记 ${r.标记}:1`)
})

/* 浅色模式的灾难性地板。
   这一类已经踩过三次：门口依据卡的纸面色 #4e4840（1.91:1）、
   .sys-note 写死的 #9fb0bd（1.85:1）、--cang 没有浅色值却被当正文色（2.62:1）。
   共同点是「暗场的颜色留在浅底上」——渲染层不报错，肉眼才知道。
   2.8 是地板不是目标：--su-mute 那类刻意压弱的层级落在 3.0 附近，
   抬不抬是设计取舍，不该由这条检查替用户决定。 */
check('contrast: 浅色模式全站文字（灾难性地板 2.8:1）', async () => {
  // reducedMotion：.nav .links a 之类有 transition，不等落定量到的是插值中间色，
  // 报出来的是假数（我见过 a 1.41:1 这种），检查会飘
  const p = await open('light', { reducedMotion: 'reduce' })
  const all = []
  for (const url of ['/', `/p/${SAMPLE.person.id}`, sampleRoute('bare')]) {
    await p.goto(`${BASE}${url}`, { waitUntil: 'networkidle' })
    await p.evaluate(() => document.body.classList.contains('light-stage')
      || document.body.classList.add('light-stage'))
    await p.waitForTimeout(250)
    for (const w of await p.evaluate(lightScanInPage)) all.push({ url, ...w })
  }
  await p.close()
  const uniq = new Map()
  for (const w of all) if (!uniq.has(w.sel) || uniq.get(w.sel).ratio > w.ratio) uniq.set(w.sel, w)
  const worst = [...uniq.values()].sort((a, b) => a.ratio - b.ratio)
  return worst.length
    ? fail(worst.slice(0, 4).map((w) => `${w.sel} ${w.ratio}:1（${w.size}「${w.txt}」${w.color}）`).join('；'))
    : ok('3 个页面，无一处低于 2.8:1')
})

/* 分节标题必须立得住。
   守的是「引子」曾经和正文同字号同字体（都是 16px 宋体），只差字距和字重——
   读起来就是上一段散文的下一行。引子是三个模块里唯一没有容器的
   （故事有纸、行迹有线表），标题一塌，整个模块的边界就全压在这两个字上。 */
check('geometry: 分节标题与正文有层级差，且朱标和分割线都渲染', async () => {
  await page.goto(`${BASE}/p/${SAMPLE.person.id}`, { waitUntil: 'networkidle' })
  const r = await page.evaluate(() => {
    const ts = [...document.querySelectorAll('.sec-title')]
    const p = document.querySelector('.prose-block p')
    if (!ts.length || !p) return null
    const body = parseFloat(getComputedStyle(p).fontSize)
    const clear = (c) => !c || /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(c)
    return {
      body,
      titles: ts.map((t) => {
        const bar = getComputedStyle(t, '::before')
        const rule = getComputedStyle(t, '::after')
        return {
          text: t.textContent,
          size: parseFloat(getComputedStyle(t).fontSize),
          barW: parseFloat(bar.width) || 0, barH: parseFloat(bar.height) || 0, barBg: bar.backgroundColor,
          ruleW: parseFloat(rule.width) || 0, ruleH: parseFloat(rule.height) || 0, ruleBg: rule.backgroundColor,
        }
      }),
      clear: ts.map((t) => [clear(getComputedStyle(t, '::before').backgroundColor),
                            clear(getComputedStyle(t, '::after').backgroundColor)]),
    }
  })
  if (!r) return fail('人物页上找不到 .sec-title 或 .prose-block p')
  const bad = []
  r.titles.forEach((t, i) => {
    if (t.size < r.body + 2) bad.push(`「${t.text}」${t.size}px 对正文 ${r.body}px，差不足 2px`)
    if (!(t.barW > 0 && t.barH > 0) || r.clear[i][0]) bad.push(`「${t.text}」朱标没渲染`)
    if (!(t.ruleW > 0 && t.ruleH > 0) || r.clear[i][1]) bad.push(`「${t.text}」分割线没渲染`)
  })
  return bad.length
    ? fail(bad.join('；'))
    : ok(`${r.titles.length} 个标题　${r.titles[0].size}px 对正文 ${r.body}px　朱标 ${r.titles[0].barW}×${r.titles[0].barH}　线宽 ${Math.round(r.titles[0].ruleW)}`)
})

/* 正文里挂「原文」牌子的那一行，必须真的出自底本。
   守的是曾经那段代码：判别用「有没有引号」，49 行独立引文里 45 行是白话，
   全被挂到了「原文」标题底下——读者看到的就是"标了原文又用翻译"。
   这条从**渲染结果**反查同一篇的「原文」页签，和编译器的判别是两套算法。
   两头都要拦：对不上底本是放松，一个都抽不出来是收紧。 */
/* 界面上不许出现内部行话。
   踩过：导航顶上「M2a · 无 AI 模式」、设置页「已标出 6 段高优先级核对项，
   另有 15 处待核疑点」、正文里「本篇的对话种子尚未编写」。
   读者看不懂，而且这些话解释的是我们的流程，不是他要读的那段历史。
   内容侧的同类问题由编译器的 JARGON 检查拦，这条拦界面。 */
check('content: 界面上没有内部行话', async () => {
  const JARGON = /C 级|C级|A 级|B 级|待核疑点|高优先级|核对项|优先级|底本标|复核|M2a|M2b|M3\b|尚未编写|里程碑/
  const bad = []
  const pages = ['/', '/settings', ...PEOPLE.map((p) => `/p/${p.id}`),
                 sampleRoute('bare'), sampleRoute('quoted')]
  for (const url of pages) {
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' })
    const hits = await page.evaluate((src) => {
      const re = new RegExp(src)
      const out = []
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walk.nextNode())) {
        const t = n.textContent.trim()
        if (t && re.test(t)) out.push(t.slice(0, 30))
      }
      return out
    }, JARGON.source)
    for (const h of hits) bad.push(`${url} 「${h}」`)
  }
  return bad.length ? fail(bad.slice(0, 4).join('；')) : ok(`${pages.length} 个页面，无内部行话`)
})

check('content: 正文里的「原文」块逐字出自底本', async () => {
  const norm = (v) => String(v).replace(/\*\*|`/g, '')
    .replace(/[『』「」“”"']/g, '').replace(/[，。；：、！？…—·　\s＝=]/g, '')
  let cites = 0, pages = 0, withQuote = 0
  const bad = []
  /* 遍历**所有人物、所有已实现篇目**。写死一个人的话，
     加到第二个人物时这条检查会静默地只查荆轲。 */
  for (const { person, story } of READY) {
    pages++
    if (story.beats.some((b) => b.quotes?.length)) withQuote++
    await page.goto(`${BASE}${routeOf({ person, story })}`, { waitUntil: 'networkidle' })
    await page.click('button.cta')
    for (let i = 0; i < 40; i++) {
      const c = await page.$('button.continue')
      if (!c) break
      await c.click(); await page.waitForTimeout(100)
    }
    const got = await page.$$eval('cite', (els) => els.map((e) => e.textContent.trim()))
    if (!got.length) continue
    cites += got.length
    await page.click('.panel-tabs button:has-text("原文")')
    await page.waitForTimeout(250)
    const hay = (await page.$$eval('.panel-face.paper .quote', (els) => els.map((e) => e.textContent.trim())))
      .map(norm).join('|')
    for (const c of got) if (!hay.includes(norm(c))) bad.push(`${person.id}/${story.id}「${c.slice(0, 16)}…」`)
  }
  if (!cites) return fail('全篇一个正文「原文」块都没有——判别可能过严，原文再也抽不出来')
  /* 内容侧说有几篇带引文，浏览器侧就该在几篇里看到 <cite>。
     两边对不上说明有篇目的引文根本没渲染出来。 */
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'content.json'), 'utf8'))
  const declared = data.people.flatMap((p) => p.storyList.filter((s) => s.ready))
  const expect = declared.filter(({ id }) => {
    const full = data.people.flatMap((p) => Object.values(p.stories)).find((s) => s.id === id)
    return full?.beats?.some((b) => b.quotes?.length)
  }).length
  if (withQuote !== expect) {
    return fail(`内容侧有 ${expect} 篇带原文台词，浏览器里只在 ${withQuote} 篇看到——有篇目的引文没渲染`)
  }
  return bad.length
    ? fail(`${bad.length} 处对不上底本：${bad.slice(0, 3).join('；')}`)
    : ok(`${pages} 篇（${withQuote} 篇带原文台词）　正文「原文」块 ${cites} 处，均逐字对得上「原文」页签`)
})

/* 读完一篇不能是死路。
   用户报过：「读完故事一之后没有能直接进入下一个故事二的地方」。
   最后一篇除外——它本来就该收尾。

   **按人物分组**：上一篇/下一篇是同一个人物内部的顺序。
   早先这里把所有人拉成一条全局序列，加进曹操（只有一篇）之后
   就以为《曹操刺董》该链到荆轲的《尾声》——那是检查自己写错了。 */
check('routes: 每篇读完都有通往下一篇的出口', async () => {
  const bad = []
  const byPerson = new Map()
  for (const r of READY) {
    if (!byPerson.has(r.person.id)) byPerson.set(r.person.id, [])
    byPerson.get(r.person.id).push(r)
  }
  let visited = 0
  for (const list of byPerson.values()) {
    for (let i = 0; i < list.length; i++) {
      const { person, story } = list[i]
      visited++
      await page.goto(`${BASE}${routeOf({ person, story })}`, { waitUntil: 'networkidle' })
      await page.click('button.cta')
      for (let k = 0; k < 40; k++) {
        const c = await page.$('button.continue')
        if (!c) break
        await c.click(); await page.waitForTimeout(60)
      }
      const hrefs = await page.$$eval('.next-bar a', (as) => as.map((a) => a.getAttribute('href')))
      /* 出口栏不能是空的。只有一篇的人物 prev/next 都不存在——
         早先那里渲染成一条空栏，读者走到死路。 */
      if (!hrefs.length) bad.push(`${person.id}/${story.id} 读完之后出口栏是空的`)
      if (i < list.length - 1 && !hrefs.includes(routeOf(list[i + 1]))) {
        bad.push(`${person.id}/${story.id} 读完没有通往 ${list[i + 1].story.id} 的入口`)
      }
      if (i > 0 && !hrefs.includes(routeOf(list[i - 1]))) {
        bad.push(`${person.id}/${story.id} 读完没有回到 ${list[i - 1].story.id} 的入口`)
      }
    }
  }
  return bad.length
    ? fail(bad.slice(0, 3).join('；'))
    : ok(`${byPerson.size} 个人物 · ${visited} 篇，读完都能接着往下走`)
})

check('geometry: 朱批印不与文字重叠', async () => {  await page.goto(`${BASE}/p/${SAMPLE.person.id}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const r = await page.evaluate(() => {
    const card = document.querySelector('.story-card.ready')
    const seal = card.querySelector('.seal')
    const q = card.querySelector('.q')
    const sr = seal.getBoundingClientRect(), qr = q.getBoundingClientRect()
    return { 文字右: Math.round(qr.right), 印左: Math.round(sr.left), 印右: Math.round(sr.right), 卡右: Math.round(card.getBoundingClientRect().right) }
  })
  if (r.印左 < r.文字右) return fail(`印左缘 ${r.印左} 压住了文字右缘 ${r.文字右}`)
  if (r.印右 > r.卡右) return fail(`印右缘 ${r.印右} 超出卡片 ${r.卡右}`)
  return ok(`文字右 ${r.文字右} < 印左 ${r.印左}；印右 ${r.印右} ≤ 卡右 ${r.卡右}`)
})

check('animation: 朱批笔圈确实在扫（不是瞬间出现）', async () => {
  await page.goto(`${BASE}/p/${SAMPLE.person.id}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.locator('.story-card.ready').first().hover()
  const pump = (n) => page.evaluate((k) => new Promise((res) => {
    let i = 0; const f = () => { i++; i < k ? requestAnimationFrame(f) : res() }; requestAnimationFrame(f)
  }), n)
  const sweep = () => page.evaluate(() => {
    const e = document.querySelector('.story-card .seal')
    return e ? getComputedStyle(e).getPropertyValue('--sweep').trim() : null
  })
  await pump(4)
  const a = await sweep()
  await pump(24)
  const b = await sweep()
  const deg = (v) => parseFloat(v) || 0
  if (deg(a) === 0) return fail('起始值是 0deg——动画没跑起来')
  if (!(deg(b) > deg(a))) return fail(`进度没有推进：${a} → ${b}`)
  return ok(`进度 ${a} → ${b}`)
})

check('font: 印章字体已加载且覆盖字表', async () => {
  const raw = fs.readFileSync(path.join(ROOT, 'config/seal-chars.txt'), 'utf8')
  const chars = [...new Set(raw.split('\n').map((l) => l.replace(/#.*$/, '').trim()).join('').split('').filter((c) => c.trim()))]
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const r = await page.evaluate(async ({ chars }) => {
    await document.fonts.ready
    const loaded = [...document.fonts].some((f) => f.family.includes('Seal') && f.status === 'loaded')
    // 逐像素比对：字体里没有这个字时浏览器会退回衬线体，渲染结果**逐像素完全一致**。
    // 签名必须用全部像素——只收集"出现过的颜色"太弱，不同字形可能撞车。
    const S = 64, W = 80
    const cv = document.createElement('canvas'); cv.width = W; cv.height = W
    const g = cv.getContext('2d', { willReadFrequently: true })
    const render = (ch, font) => {
      g.clearRect(0, 0, W, W); g.font = `${S}px ${font}`; g.fillStyle = '#000'
      g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(ch, W / 2, W / 2)
      const d = g.getImageData(0, 0, W, W).data
      let h = 2166136261
      // 四个通道都要哈希。只读红通道的话，黑字画在透明底上红通道全是 0，
      // 任何字形都会得到同一个哈希——这个坑我踩过。
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619) }
      return h >>> 0
    }
    const missing = [], blank = []
    for (const ch of chars) {
      const a = render(ch, '"Guanshi Seal"'), b = render(ch, 'serif')
      if (a === 0) { blank.push(ch); continue }
      if (a === b) missing.push(ch)
    }
    return { loaded, missing, blank }
  }, { chars })
  if (!r.loaded) return fail('Guanshi Seal 没有加载')
  if (r.blank.length) return fail(`有 ${r.blank.length} 个字画不出来：${r.blank.join(' ')}`)
  if (r.missing.length) return fail(`字体里缺 ${r.missing.length} 个字：${r.missing.join(' ')}`)
  return ok(`已加载，字表 ${chars.length} 字全部覆盖`)
})

/* ── 跑 ─────────────────────────────────────────── */

try {
  if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chromium：${CHROME}`)
  browser = await chromium.launch({ executablePath: CHROME })

  /* 探活就是 open() 本身——它已经会导航到 BASE/。
     不要在这之后再对**同一个 URL** goto 一次并等 domcontentloaded：
     Chromium 不会为第二次同址导航再发一次这个事件，goto 会一直挂到超时，
     于是所有检查都报「连不上」，而 curl 明明是 200。
     （同址 goto 用 waitUntil:'commit' 或 reload() 都正常，只有 domcontentloaded 会挂。） */
  try {
    page = await open()
  } catch {
    console.error(`\n  ✗ 连不上 ${BASE}\n    先跑 npm run dev 或 npm start\n`)
    await browser.close()
    process.exit(1)
  }

  const todo = FILTER ? results.filter((r) => r.name.includes(FILTER)) : results
  console.log(`\n观史 · 浏览器验证${FILTER ? `（筛选：${FILTER}）` : ''}\n`)

  let failed = 0
  for (const { name, fn } of todo) {
    let r
    try { r = await fn() } catch (e) { r = fail(`检查本身出错：${String(e.message).slice(0, 160)}`) }
    console.log(`  ${r.pass ? '✓' : '✗'} ${name}`)
    console.log(`      ${r.msg}`)
    if (!r.pass) failed++
  }

  console.log(failed ? `\n  ✗ ${failed} / ${todo.length} 项未通过\n` : `\n  ✓ ${todo.length} 项全部通过\n`)
  await browser.close()
  process.exit(failed ? 1 : 0)
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`)
  if (browser) await browser.close()
  process.exit(1)
}
