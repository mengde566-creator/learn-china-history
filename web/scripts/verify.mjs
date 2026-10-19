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
import { sourceReferences } from '../lib/cite-ids.mjs'
import { plainSourceText } from '../lib/source-layers.mjs'

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
  /* **完整资料页也要进验证清单。** 评估时 22 个页面里没有它，
     而 R01 的排版故障就出在这一页上。 */
  ...PEOPLE.map((p) => `/p/${p.id}/source`),
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
  await page.locator('.opening-notes summary').click()
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
/* 用户当场问过的那句话：「你要是引的三国演义就应该标记三国演义啊，
   原文你知道标三国志武帝纪怎么这里又不标注了」。
   这一条守的就是它：**页面上只要出现「小说」两个字，同一行里就得有书名。**
   标记（◇）、档次名、书名是三样东西，只有书名告诉读者该不该信。

   为什么放在 verify 而不是编译器里：这是一个**渲染结果**的性质。
   编译器管得了内容，管不了「图例由哪个人物的哪个字段生成」。
   实测漏过一处——荆轲没有小说底本，图例却无条件印着「出自小说，不是史书」。
   编译器对那一行一无所知。 */
check('content: 说了「小说」就得说是哪一本', async () => {
  const bad = []
  const pages = PEOPLE.flatMap((p) => [p.id, ...p.storyList.filter((s) => s.ready).map((s) => `${p.id}/${s.id}`)])
  for (const r of pages) {
    const url = r.includes('/') ? `/p/${r}` : `/p/${r}`
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' })
    /* 故事页的图例在「门口」那一屏，点进去就没了——两个状态都要看 */
    const seen = new Set()
    for (const step of [0, 1]) {
      if (step === 1) {
        const cta = await page.$('button.cta')
        if (!cta) break
        await cta.click()
        await page.waitForTimeout(150)
      }
      const hits = await page.evaluate(() => {
        const out = []
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let n
        while ((n = walk.nextNode())) {
          if (!n.textContent.includes('小说')) continue
          /* **看的是包含这个文字节点的元素，不是那个文字节点本身。**
             JSX 里写 `出自小说{book}，不是史书`，浏览器拿到的是三个并列的文字节点，
             中间那个（「出自小说」）没有书名号——按节点判会误报。
             按元素判就对了：它拿到的是一整行的文字。
             但也不能一路往上找到 body（那样整页别的书名会把这一行救下来），
             所以取最近的这个元素，不再往上。 */
          const el = n.parentElement
          /* 跳过 <script>：Next 的 flight 数据里也有「小说」两个字，
             而它的「元素」是整段序列化的载荷。 */
          if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue
          const t = (el.textContent || '').trim()
          if (t) out.push(t)
        }
        return out
      })
      for (const h of hits) seen.add(h)
    }
    for (const h of seen) {
      if (!/[《〈].+?[》〉]/.test(h)) bad.push(`${url} 「${h.slice(0, 34)}」`)
    }

  }
  return bad.length
    ? fail(`说了小说不说是哪一本：${bad.slice(0, 3).join('；')}`)
    : ok(`${pages.length} 个页面 · 两个状态，凡说「小说」都带着书名`)
})

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
    await page.getByRole('button', { name: '查证与背景', exact: true }).click()
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

  /* ══════════════════════════════════════════════
   R01–R10 的回归检查
   ══════════════════════════════════════════════ */

/**
 * **每条检查开始前清掉本机进度。**
 *
 * R12 之后，故事页会把阅读位置存进 localStorage——同一个浏览器上下文里，
 * 上一条检查进过场景，下一条 `goto` 就会**直接恢复到正文**，
 * 于是入场页的按钮和逐行依据都不在了，检查报「找不到 button.cta」。
 * 这不是产品的问题，是检查要自己保证起点的干净。
 */
async function resetLocal() {
  try {
    await page.evaluate(() => { try { localStorage.clear() } catch {} })
  } catch {}
}

/** 走到正文里（入场页上有个「进 入」按钮）。 */
async function enterStory() {
  await resetLocal()
  const cta = await page.$('button.cta')
  if (cta) { await cta.click(); await page.waitForTimeout(500) }
}

check('R01: 资料页的原文与直译在同一列、原文不是朱红、没有裸露的 **', async () => {
  const bad = []
  for (const person of PEOPLE) {
    await page.goto(`${BASE}/p/${person.id}/source`, { waitUntil: 'networkidle' })
    const r = await page.evaluate(() => {
      const li = document.querySelector('.src-item')
      if (!li) return null
      const tx = li.querySelector('.src-text')?.getBoundingClientRect()
      const gl = li.querySelector('.src-gloss')?.getBoundingClientRect()
      const cs = li.querySelector('.src-text') ? getComputedStyle(li.querySelector('.src-text')) : null
      return {
        txX: tx ? Math.round(tx.left) : null, txW: tx ? Math.round(tx.width) : null,
        glX: gl ? Math.round(gl.left) : null,
        color: cs?.color,
        stars: (document.body.innerText.match(/\*\*/g) || []).length,
      }
    })
    if (!r) { bad.push(`${person.id}/source 没有 .src-item`); continue }
    if (!(r.txW > 200)) bad.push(`${person.id}/source 原文列只有 ${r.txW}px`)
    if (r.glX !== null && r.glX !== r.txX) bad.push(`${person.id}/source 直译左 ${r.glX} ≠ 原文 ${r.txX}（掉进编号列）`)
    if (/^rgb\(184, 64, 47\)/.test(r.color)) bad.push(`${person.id}/source 原文是朱红 ${r.color}`)
    if (r.stars) bad.push(`${person.id}/source 露出 ${r.stars} 处 **`)
  }
  return bad.length ? fail(bad.join('；')) : ok(`${PEOPLE.length} 个资料页：同列、正文色、无 **`)
})

check('R02: 背景卡的出处对照表渲染成表格，不是被吞掉', async () => {
  await page.goto(`${BASE}/p/caocao/09-chibi`, { waitUntil: 'networkidle' })
  await enterStory()
  await page.getByRole('button', { name: '查证与背景', exact: true }).click()
  await page.getByRole('button', { name: '背景', exact: true }).click()
  await page.waitForTimeout(400)
  const t = page.locator('.bg-table').first()
  if (!(await t.count())) return fail('背景卡里没有 .bg-table——表格在编译期被吞了')
  const rows = await t.locator('tbody tr').count()
  const head = await t.locator('th').count()
  if (head < 2) return fail(`表头只有 ${head} 格`)
  if (rows < 3) return fail(`表体只有 ${rows} 行（「谁烧的船」应有 4 行）`)
  return ok(`「谁烧的船」对照表：表头 ${head} 格、表体 ${rows} 行`)
})

check('R09: 依据里的编号能跳到原文，并且能返回', async () => {
  await page.goto(`${BASE}/p/caocao/08-guandu`, { waitUntil: 'networkidle' })
  const notes = page.locator('.opening-notes')
  if (await notes.getAttribute('open') !== null) return fail('铺陈依据应默认收起')
  await notes.locator('summary').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.opening-notes')?.open)
  const cites = await page.locator('button.cite:not(.back)').count()
  if (!cites) return fail('入场页的逐行依据里没有可点编号')
  const id = (await page.locator('button.cite:not(.back)').first().textContent()).trim()
  await page.locator('button.cite:not(.back)').first().click()
  await page.waitForTimeout(800)
  if (!(await page.locator(`#src-${id}`).count())) return fail(`点了「${id}」但原文页签里没有 #src-${id}`)
  const back = page.locator('button.cite.back')
  if (!(await back.count())) return fail(`跳到 ${id} 之后没有返回入口`)
  await back.first().click()
  await page.waitForTimeout(600)
  if (!(await page.locator('.note-box').count())) return fail('点返回之后没有回到入场页')
  if (await notes.getAttribute('open') === null) return fail('返回后没有保留依据展开状态')
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('cite')))) return fail('返回后键盘焦点未回原编号')
  return ok(`默认收起、键盘展开；${cites} 个可点编号；点「${id}」跳转并返回后仍展开`)
})

check('F11: 背景编号直达完整原文，返回原背景位置与焦点', async () => {
  const cases = [
    { person: 'caocao', story: '06-qingzhou', background: '受降之前', id: '226' },
    { person: 'jingke', story: '01-yanwei', background: '击筑', id: '091' },
    { person: 'caocao', story: '03-chenliu', background: '中平六年', id: '014' },
  ]
  const settle = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const compact = text => plainSourceText(text).replace(/\s/g, '')
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    try {
      const p = await context.newPage()
      await p.goto(BASE)
      const oldReview = { 'gaohuan/01-hanshi': { 1: 'known' }, 'yuwentai/01-luanjun': { 2: 'todo' } }
      await p.evaluate(review => localStorage.setItem('guanshi.progress.v1', JSON.stringify({ read: {}, review, last: null })), oldReview)
      for (const item of cases) {
        const person = PEOPLE.find(person => person.id === item.person)
        const story = person.stories[item.story]
        await p.goto(`${BASE}/p/${item.person}/${item.story}`, { waitUntil: 'networkidle' })
        await p.locator('button.cta').click()
        await p.locator('#beat-1 .ground').click()
        await p.locator('.panel-tabs').getByRole('button', { name: '背景', exact: true }).click()
        await settle(p)
        // 同页所有背景都核对链接，纪年、较长数字和不存在的编号不能变成入口。
        const backgrounds = p.locator('.panel-face .mark-block')
        for (const [index, bg] of story.backgrounds.entries()) {
          const expected = [...sourceReferences(bg.basis)].map(m => m[1]).filter(id => person.source[id])
          const actual = (await backgrounds.nth(index).locator('button.cite').allTextContents()).map(t => t.trim())
          if (JSON.stringify(actual) !== JSON.stringify(expected)) return fail(`${width}px ${item.story}/${bg.name}: 背景编号不符 ${JSON.stringify(actual)}`)
        }
        const bgIndex = story.backgrounds.findIndex(bg => bg.name === item.background)
        const citation = backgrounds.nth(bgIndex).getByRole('button', { name: item.id, exact: true }).first()
        // 滚动旁批本身使编号可见，不能用强制点击或移动整篇正文代替正常操作。
        await citation.evaluate(el => {
          const pane = el.closest('.panel-face')
          pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2
        })
        await settle(p)
        await citation.scrollIntoViewIfNeeded()
        await settle(p)
        const before = await p.evaluate(() => ({ y: scrollY, pane: document.querySelector('.panel-face').scrollTop, progress: localStorage.getItem('guanshi.progress.v1') }))
        await citation.click()
        await p.locator(`#src-${item.id}`).waitFor()
        await settle(p)
        if (compact(await p.locator(`#src-${item.id} .quote`).innerText()) !== compact(person.source[item.id].text)) return fail(`${width}px ${item.story}: 原文不完整`)
        if (item.id === '091' && !(await p.locator('#src-091').innerText()).includes('补充参照')) return fail('跨篇091未说明补充性质')
        if (await p.evaluate(() => scrollY) !== before.y) return fail(`${width}px ${item.story}: 查证带动正文`)
        await p.locator(`#src-${item.id} button.back`).click()
        await settle(p)
        const after = await p.evaluate(() => ({ y: scrollY, pane: document.querySelector('.panel-face').scrollTop, progress: localStorage.getItem('guanshi.progress.v1'), tab: document.querySelector('.panel-tabs [aria-current=true]')?.textContent }))
        if (after.tab !== '背景' || Math.abs(after.y - before.y) > 2 || Math.abs(after.pane - before.pane) > 2) return fail(`${width}px ${item.story}: 返回位置丢失 ${JSON.stringify({ before, after })}`)
        if (!(await citation.evaluate(el => document.activeElement === el))) return fail(`${width}px ${item.story}: 焦点没有回到原背景编号`)
        if (after.progress !== before.progress) return fail(`${width}px ${item.story}: 查证改写了阅读或复习数据 ${before.progress} -> ${after.progress}`)
        if (JSON.stringify(JSON.parse(after.progress).review) !== JSON.stringify(oldReview)) return fail('已有复习记录被改写')
        if (item.id === '226') await p.screenshot({ path: `/tmp/guanshi-background-cite-${width}.png` })
        await p.keyboard.press('Escape'); await settle(p)
      }
    } finally { await context.close() }
  }
  return ok('两种尺寸：226、跨篇091及014原文完整；背景内滚动、正文位置、焦点及旧复习记录保留，纪年不生成链接')
})

check('F09: 三篇主线理由与跨年衔接可顺读，旧续读和复习保留', async () => {
  const ids = ['03-chenliu', '05-yanzhou', '06-qingzhou']
  const numbers = [3, 7, 1]
  const settle = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    try {
      const p = await context.newPage()
      await p.goto(BASE)
      const fixture = {
        read: Object.fromEntries(ids.map((id, i) => [`caocao/${id}`, { beat: numbers[i], beatCount: [7, 10, 5][i], phase: 'live', done: false, at: 100 + i }])),
        review: { 'caocao/03-chenliu': { 1: 'known', 9: 'todo' }, 'caocao/05-yanzhou': { 4: 'known' }, 'caocao/06-qingzhou': { 5: 'todo' }, 'yuwentai/01-luanjun': { 2: 'known' } }, last: null,
      }
      fixture.read['yuwentai/01-luanjun'] = { beat: 2, beatCount: 3, phase: 'live', done: false, at: 99 }
      await p.evaluate(value => localStorage.setItem('guanshi.progress.v1', JSON.stringify(value)), fixture)
      for (const [i, id] of ids.entries()) {
        await p.goto(`${BASE}/p/caocao/${id}`, { waitUntil: 'networkidle' })
        await p.waitForSelector('.reader .beat')
        await p.evaluate(() => document.fonts.ready); await settle(p); await settle(p)
        if (await p.locator('button.cta').count()) return fail(`${id} 旧续读没有进入正文`)
        if (numbers[i] > 1) {
          // 短篇接近文末时滚动会受页面底部限制；仍须回到原段能达到的位置。
          try { await p.waitForFunction(n => {
            const y = document.getElementById(`beat-${n}`).getBoundingClientRect().top
            const expected = Math.max(105, y + scrollY - (document.documentElement.scrollHeight - innerHeight))
            return Math.abs(y - expected) < 3
          }, numbers[i], { timeout: 5000 }) } catch {
            await p.screenshot({ path: `/tmp/guanshi-f09-restore-failed-${width}-${id}.png` })
            return fail(`${width}px ${id} 旧续读位置不符 ${JSON.stringify(await p.evaluate(n => ({ y: document.getElementById(`beat-${n}`).getBoundingClientRect().top, scroll: scrollY, max: document.documentElement.scrollHeight - innerHeight, saved: JSON.parse(localStorage.getItem('guanshi.progress.v1')).read }), numbers[i]))}`)
          }
        }
        if (id === '03-chenliu') {
          const text = (await p.locator('.reader .narration').allTextContents()).join('\n')
          if (text.includes('袁遗') || text.includes('扬州刺史')) return fail('后事小传仍打断陈留主线')
          if ((text.match(/初平元年/g) || []).length !== 1 || !text.includes('允许他起兵')) return fail('陈留跨年或允许起兵的承接缺失')
        } else {
          const text = await p.locator(`#beat-${numbers[i]} .narration`).innerText()
          const required = id === '05-yanzhou' ? ['没有辎重', '先保存兵力', '占住要害'] : ['裴松之注引《魏书》', '申明赏罚', '投降的出路', '《武帝纪》正文']
          if (required.some(part => !text.includes(part))) return fail(`${id} 顺读中缺理由或出处归属`)
        }
        await p.screenshot({ path: `/tmp/guanshi-f09-reading-${id}-${width}.png` })
        const n = id === '03-chenliu' ? 7 : numbers[i]
        const trigger = p.locator(`#beat-${n} .ground`)
        await trigger.scrollIntoViewIfNeeded(); await settle(p)
        await trigger.click(); await settle(p)
        const expected = id === '03-chenliu' ? '同时俱起兵' : id === '05-yanzhou' ? '鲍信谏曰' : '亲巡将士'
        if (!(await p.locator('.panel-body').innerText()).includes(expected)) return fail(`${id} 当前段旁批缺相应材料`)
        if (id === '06-qingzhou' && !/裴松之注引《?魏书/.test(await p.locator('.panel-body').innerText())) return fail('226未显示注文归属')
        await p.keyboard.press('Escape'); await settle(p)
        const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1')))
        if (JSON.stringify(saved.review) !== JSON.stringify(fixture.review)) return fail('旧复习记录发生变化')
        if (JSON.stringify(saved.read['yuwentai/01-luanjun']) !== JSON.stringify(fixture.read['yuwentai/01-luanjun'])) return fail('另一人物阅读记录发生变化')
      }
    } finally { await context.close() }
  }
  return ok('三篇两种尺寸：原因和转折接入正文，小传归背景，跨年一次；旧段号续读、复习和另一人物记录保留')
})

check('R10: 面板页签可以用键盘走到', async () => {
  await page.goto(`${BASE}${routeOf(READY[0])}`, { waitUntil: 'networkidle' })
  await enterStory()
  await page.getByRole('button', { name: '查证与背景', exact: true }).click()
  await page.keyboard.press('Tab')
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('.panel-tabs button')].map((b) => ({ tag: b.tagName, tab: b.tabIndex, dis: b.disabled })))
  if (btns.length < 5) return fail(`面板页签只有 ${btns.length} 个`)
  const bad = btns.filter((b) => b.tag !== 'BUTTON' || b.tab < 0 || b.dis)
  return bad.length ? fail(`${bad.length} 个页签不是可聚焦的 button（键盘走不到）`) : ok(`${btns.length} 个页签都是可聚焦的 button`)
})

check('铺陈衔接: 依据先展示当前摘句，全文与多来源均可核对', async () => {
  for (const [id, current, later] of [
    ['01-wusebang', '太祖初入尉廨', '蹇硕叔父夜行'],
    ['04-xingyang', '二月，卓闻兵起', '遇卓将徐荣'],
  ]) {
    await page.goto(`${BASE}/p/caocao/${id}`, { waitUntil: 'networkidle' })
    await enterStory()
    await page.locator('#beat-1 .ground').click()
    const panel = page.locator('.panel-body')
    const initial = await panel.innerText()
    if (!initial.includes(current) || initial.includes(later)) return fail(`${id} 摘句没有聚焦当前情节`)
    const context = panel.locator('.source-context').first()
    await context.locator('summary').focus()
    await page.keyboard.press('Enter')
    if (!(await panel.innerText()).includes(later)) return fail(`${id} 完整上下文未展开`)
    if (id === '01-wusebang') {
      await page.locator('#beat-3 .ground').click()
      await page.waitForFunction(() => document.querySelectorAll('.panel-body .lead').length === 3)
      if (await panel.locator('.lead').count() !== 3) return fail('多来源情节漏掉了关联底本')
      const evidence = await panel.innerText()
      if (!evidence.includes('征拜议郎') || !evidence.includes('迁顿丘令')) return fail('关联来源的文字不完整')
    }
  }
  return ok('两篇首段不提前展开后续情节；键盘可展开全文；三来源情节均保留')
})

check('铺陈衔接: 全部故事在桌面与手机入口可读且能直接进入', async () => {
  const bad = []
  let visited = 0
  for (const [mode, viewport] of [
    ['dark', { width: 1440, height: 1000 }],
    ['light', { width: 390, height: 844 }],
  ]) {
    const p = await open(mode, { viewport, reducedMotion: 'reduce' })
    try {
      for (const item of READY) {
        await p.goto(`${BASE}${routeOf(item)}`, { waitUntil: 'networkidle' })
        await p.evaluate(() => document.fonts.ready)
        const r = await p.evaluate(() => {
          const opening = document.querySelector('.opening')
          const cta = opening?.querySelector('button.cta')
          return {
            paragraphs: opening?.querySelectorAll('.lines p').length || 0,
            cta: cta?.getBoundingClientRect().bottom,
            overflow: document.documentElement.scrollWidth > innerWidth,
            notesOpen: document.querySelector('.opening-notes')?.open,
          }
        })
        visited++
        const label = `${routeOf(item)} ${viewport.width}px`
        if (!r.paragraphs || !r.cta) bad.push(`${label} 缺铺陈或入口`)
        if (r.cta > viewport.height) bad.push(`${label} 入口落在首屏之外`)
        if (r.overflow) bad.push(`${label} 横向溢出`)
        if (r.notesOpen) bad.push(`${label} 依据未默认收起`)
        if (p.__errors.length) bad.push(`${label} ${p.__errors[0]}`)
        p.__errors = []
      }
    } finally {
      await p.close()
    }
  }
  return bad.length ? fail(bad.slice(0, 5).join('；')) : ok(`${READY.length} 篇 · ${visited} 个入口，明暗两种模式、桌面与手机均无溢出，按钮在首屏`)
})

check('铺陈衔接: 改段后的旧进度继续阅读且保留复习记录', async () => {
  const cases = [
    ['caocao', '01-wusebang', { beat: 5 }, 2],
    ['caocao', '04-xingyang', { beat: 5 }, 4],
    ['caocao', '06-qingzhou', { beat: 7, beatCount: 10 }, 2],
    ['caocao', '06-qingzhou', { beat: 10, done: true }, 5],
    ['caocao', '01-wusebang', { beat: 3, beatCount: 7 }, 3],
    ['jingke', '07-tupo', { beat: 3 }, 3],
  ]
  for (const [person, story, record, expected] of cases) {
    await page.goto(BASE, { waitUntil: 'networkidle' })
    const key = `${person}/${story}`
    await page.evaluate(({ key, record }) => {
      localStorage.setItem('guanshi.progress.v1', JSON.stringify({
        read: { [key]: { ...record, phase: 'live' } }, review: { [key]: { '1': 'known' } }, last: null,
      }))
    }, { key, record })
    await page.goto(`${BASE}/p/${person}`, { waitUntil: 'networkidle' })
    const recent = await page.getByRole('heading', { name: '最近阅读', exact: true }).locator('..').innerText()
    if (!recent.includes(record.done ? '读完了' : `读到第 ${expected} 段`)) return fail(`${key} 人物页仍显示旧段号`)
    await page.goto(`${BASE}/p/${person}/${story}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(({ key, expected }) => {
      const saved = JSON.parse(localStorage.getItem('guanshi.progress.v1'))?.read?.[key]
      return saved?.beat === expected && saved?.beatCount > 0
    }, { key, expected })
    const position = await page.locator(`#beat-${expected}`).boundingBox()
    if (!position || Math.abs(position.y - 105) > 30) return fail(`${key} 应恢复到 ${expected} 段，实际顶部 ${position?.y}`)
    const review = await page.evaluate(key => JSON.parse(localStorage.getItem('guanshi.progress.v1')).review[key], key)
    if (review['1'] !== 'known') return fail(`${key} 复习记录被改动`)
  }
  return ok('六种旧记录、已完成记录与新版记录均恢复正确，复习状态保留')
})

check('连续阅读: 查证不遮挡正文，关闭后原位返回', async () => {
  const findObscuredText = () => {
        const pane = document.querySelector('#source-panel').getBoundingClientRect()
        const hits = []
        for (const area of document.querySelectorAll('.reader .narration')) {
          const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            if (!node.textContent.trim()) continue
            const range = document.createRange(); range.selectNodeContents(node)
            for (const r of range.getClientRects()) {
              const left = Math.max(r.left, pane.left, 0), right = Math.min(r.right, pane.right, innerWidth)
              const top = Math.max(r.top, pane.top, 55), bottom = Math.min(r.bottom, pane.bottom, innerHeight)
              if (right - left > 2 && bottom - top > 2) { hits.push(node.textContent.trim().slice(0, 32)); break }
            }
            if (hits.length) break
          }
          if (hits.length) break
        }
        return hits
  }

  for (const viewport of [{ width: 1324, height: 841 }, { width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const p = await open('light', { viewport, reducedMotion: 'reduce' })
    try {
      if (viewport.width === 1324) {
        await p.goto(`${BASE}/p/caocao/01-wusebang`, { waitUntil: 'networkidle' })
        await p.locator('button.cta').click()
        await p.getByRole('button', { name: '查证与背景', exact: true }).click()
        const covered = await p.evaluate(findObscuredText)
        if (covered.length) return fail(`1324px 五色棒查证栏遮住正文：${covered[0]}`)
        await p.locator('.panel-close').click()
      }
      await p.goto(`${BASE}/p/caocao/04-xingyang`, { waitUntil: 'networkidle' })
      await p.locator('button.cta').click()
      await p.waitForTimeout(200)
      if (await p.locator('.beat').count() !== 8 || await p.locator('button.continue').count()) return fail('仍按点击截断正文')
      if (await p.locator('#source-panel').isVisible()) return fail('查证面板默认占屏')
      const saved = () => p.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1'))?.read?.['caocao/04-xingyang'])
      if ((await saved())?.done) return fail('仅渲染全文就记成已读完')
      await p.evaluate(() => window.scrollTo(0, scrollY + document.querySelector('#beat-4').getBoundingClientRect().top - 110))
      await p.waitForFunction(() => JSON.parse(localStorage.getItem('guanshi.progress.v1'))?.read?.['caocao/04-xingyang']?.beat >= 4)
      const before = await p.locator('#beat-4').boundingBox()
      const reading = await saved()
      await p.locator('#beat-4 .ground').click()
      await p.waitForTimeout(150)
      const panel = await p.locator('#source-panel').boundingBox()
      const after = await p.locator('#beat-4').boundingBox()
      if (!panel || panel.y < 55 || panel.y + panel.height > viewport.height + 2) return fail(`${viewport.width}px 查证栏跑到视口之外`)
      const heading = await p.locator('.panel-heading').boundingBox()
      const close = await p.locator('.panel-close').boundingBox()
      const restart = await p.locator('#source-panel .panel-restart').boundingBox()
      if (close.y < heading.y || close.y + close.height > heading.y + heading.height + 1 || (restart && Math.min(close.x + close.width, restart.x + restart.width) > Math.max(close.x, restart.x) + 1 && Math.min(close.y + close.height, restart.y + restart.height) > Math.max(close.y, restart.y) + 1)) return fail('查证关闭按钮越出标题栏，压到从头读')
      // 正文宽度不变不能证明未遮挡；逐个可见文字行检查是否被面板覆盖。
      const obscured = await p.evaluate(findObscuredText)
      if (obscured.length) return fail(`${viewport.width}px 查证栏遮住正文：${obscured[0]}`)
      if ((await saved()).beat !== reading.beat) return fail('查证行为推进了阅读进度')
      await p.keyboard.press('Escape')
      if (await p.locator('#source-panel').isVisible()) return fail('Escape 未关闭查证')
      if (!(await p.evaluate(() => document.activeElement === document.querySelector('#beat-4 .ground')))) return fail('查证关闭后焦点未返回依据入口')
      await p.reload({ waitUntil: 'networkidle' })
      const anchor = await p.locator(`#beat-${reading.beat}`).boundingBox()
      if (Math.abs(anchor.y - 105) > 30) return fail('刷新未接着阅读位置')
      if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) return fail('正文横向溢出')
    } finally { await p.close() }
  }
  return ok('全文连贯呈现；真实滚动推进、查证原位、焦点返回与刷新续读，桌面手机均通过')
})

check('读后追问: 手机桌面原地查证，键盘关闭与焦点返回', async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const p = await open('light', { viewport, reducedMotion: 'reduce' })
    try {
      await p.goto(`${BASE}/p/gaohuan/01-hanshi`, { waitUntil: 'networkidle' })
      await p.locator('button.cta').click()
      await p.locator('.next-bar').scrollIntoViewIfNeeded()
      await p.locator('.ask-btn').scrollIntoViewIfNeeded()
      const before = await p.evaluate(() => ({ y: scrollY, saved: localStorage.getItem('guanshi.progress.v1') }))
      await p.locator('.ask-btn').click()
      const dialog = p.getByRole('dialog')
      if (await dialog.getAttribute('aria-modal') !== 'true' || await dialog.locator('input,textarea').count()) return fail('追问不是预置问题模态面板')
      await dialog.locator('.seed-meta button.cite').first().click()
      const quote = await dialog.locator('.seed-citation blockquote').innerText()
      const expected = DATA.people.find(person => person.id === 'gaohuan').source['004'].text
      if (quote.replace(/\s/g, '') !== expected.replace(/\s/g, '')) return fail('追问引用未原地展示相应底本')
      if (await p.locator('#source-panel').isVisible()) return fail('追问查证打开了另一个冲突面板')
      await dialog.locator('button').last().focus()
      await p.keyboard.press('Tab')
      if (!(await p.evaluate(() => document.activeElement === document.querySelector('.sheet-inner button')))) return fail('Tab 焦点逃出追问面板')
      await p.keyboard.press('Escape')
      if (await dialog.count()) return fail('Escape 没有关掉追问')
      const after = await p.evaluate(() => ({ y: scrollY, saved: localStorage.getItem('guanshi.progress.v1'), focus: document.activeElement === document.querySelector('.ask-btn'), overflow: document.body.style.overflow }))
      if (!after.focus || Math.abs(after.y - before.y) > 2 || after.overflow === 'hidden') return fail('关闭后未恢复阅读位置、滚动或焦点')
      if (after.saved !== before.saved) return fail('问答查证改写了阅读记录')
    } finally { await p.close() }
  }
  return ok('预置追问内可查原文，焦点留在面板内；关闭后回到原阅读位置，进度不变')
})

check('高欢查证: 十篇逐段显示具体依据，多书原文不缺失', async () => {
  const person = DATA.people.find(person => person.id === 'gaohuan')
  const p = await open('light', { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const compact = text => String(text).replace(/[`\s]/g, '')
  let beats = 0
  let citations = 0
  try {
    for (const story of Object.values(person.stories)) {
      await p.goto(`${BASE}/p/gaohuan/${story.id}`, { waitUntil: 'networkidle' })
      await p.locator('button.cta').click()
      for (const beat of story.beats) {
        await p.locator(`#beat-${beat.n} .ground`).click()
        const face = p.locator('#source-panel .panel-face')
        const ground = await face.locator('.mark-block .body').innerText()
        if (compact(ground) !== compact(beat.ground) || ground.includes('叙述中明确说明的比较与判断')) return fail(`${story.id} 第${beat.n}段未展示具体依据`)
        const leads = compact((await face.locator('.lead').allInnerTexts()).join(''))
        for (const id of beat.sources) {
          if (!leads.includes(compact(person.source[id].text))) return fail(`${story.id} 第${beat.n}段的${id}原文缺失`)
          citations++
        }
        beats++
        await p.keyboard.press('Escape')
      }
    }
    return ok(`${Object.keys(person.stories).length}篇 · ${beats}段具体依据 · ${citations}处引用，手机可展开查看完整原文`)
  } finally { await p.close() }
})

check('出处分层: 正文、注与合引书目和白话逐片对应', async () => {
  const compact = value => String(value).replace(/\s|\*|`/g, '')
  let pieces = 0
  for (const width of [390, 1440]) {
    const p = await open('dark', { viewport: { width, height: 950 }, reducedMotion: 'reduce' })
    try {
      for (const person of PEOPLE) {
        const rows = Object.values(person.source).filter(s => s.parts)
        if (!rows.length) continue
        await p.goto(`${BASE}/p/${person.id}/source`, { waitUntil: 'networkidle' })
        for (const row of rows) {
          const entry = p.locator(`#s-${row.id}`), parts = entry.locator('.source-layer')
          if (await parts.count() !== row.parts.length) return fail(`${width}px ${row.id} 分层缺失`)
          const text = (await entry.locator('.src-text').allTextContents()).join('')
          const gloss = (await entry.locator('.src-gloss').allTextContents()).map(t => t.replace(/^白话/, '')).join('')
          if (compact(text) !== compact(row.text) || compact(gloss) !== compact(person.gloss[row.id])) return fail(`${width}px ${row.id} 原文或白话丢失、重复或错序`)
          for (let i = 0; i < row.parts.length; i++) {
            if (await parts.nth(i).getAttribute('data-source-tier') !== row.parts[i].tier || await parts.nth(i).locator('.source-layer-heading').innerText() !== row.parts[i].origin) return fail(`${width}px ${row.id} 第${i + 1}片的档次或出处错误`)
            pieces++
          }
          await entry.scrollIntoViewIfNeeded()
          if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) return fail(`${width}px ${row.id} 出处文字撑出屏幕`)
        }
      }
      if (p.__errors.length) return fail(p.__errors.join('；'))
    } finally { await p.close() }
  }
  return pieces ? ok(`桌面手机共${pieces}个分片，原文、白话、档次、引书无损对应`) : fail('未找到真实分层材料，检查没有覆盖对象')
})

check('复习表格: 出处对读保留真实表头、数据行及复习记录', async () => {
  const cases = [
    ['02-cidong', 2, ['来源', '经过'], ['《武帝纪》正文', '裴注引《魏书》', '《三国演义》第四回']],
    ['02-cidong', 8, ['出处', '经过', '方向'], ['《魏书》', '《世语》', '孙盛《杂记》']],
    ['09-chibi', 1, ['出处', '说'], [
      '《周瑜传》正文（113、114）', '《周瑜传》裴注引《江表传》（312）',
      '《周瑜传》另一处裴注引《江表传》（313）', '《吴主传》正文（外证）',
      '裴注引《山阳公载记》（265）',
    ]],
  ]
  for (const width of [390, 1440]) {
    const p = await open('light', { viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
    try {
      const review = { 'caocao/02-cidong': { 2: 'known', 8: 'todo' }, 'caocao/09-chibi': { 1: 'known' } }
      await p.evaluate(({ review, stories }) => {
        localStorage.setItem('guanshi.progress.v1', JSON.stringify({
          read: Object.fromEntries(stories.map(({ id, count }) => [`caocao/${id}`, { beat: count, beatCount: count, phase: 'live', done: true }])),
          review, last: null,
        }))
      }, { review, stories: ['02-cidong', '09-chibi'].map((id) => ({ id, count: PEOPLE.find((x) => x.id === 'caocao').stories[id].beats.length })) })
      for (const [id, n, head, labels] of cases) {
        await p.goto(`${BASE}/p/caocao/${id}`, { waitUntil: 'networkidle' })
        const card = p.locator('.cards .card').nth(n - 1)
        await card.getByRole('button', { name: /点开看答案/ }).click()
        const table = card.locator('table.mini-table')
        if (JSON.stringify(await table.locator('thead th').allTextContents()) !== JSON.stringify(head)) return fail(`${width}px ${id} 卡${n} 表头被吞或被数据行替代`)
        const rows = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.cells].map((c) => c.textContent)))
        if (JSON.stringify(rows.map((r) => r[0])) !== JSON.stringify(labels) || rows.some((r) => r.length !== head.length)) return fail(`${width}px ${id} 卡${n} 数据行或列数错误`)
        const expected = PEOPLE.find((x) => x.id === 'caocao').stories[id].cards.find((c) => c.n === n).blocks.find((b) => b.t === 'table')
        if (JSON.stringify(rows) !== JSON.stringify(expected.rows)) return fail(`${width}px ${id} 卡${n} 表格文字不完整`)
        const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('guanshi.progress.v1')).review)
        if (JSON.stringify(saved) !== JSON.stringify(review)) return fail('展开表格改写了复习状态')
        if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) return fail(`${width}px 表格导致整页横向溢出`)
      }
      if (p.__errors.length) return fail(p.__errors[0])
    } finally { await p.close() }
  }
  return ok('三张真实对读卡在桌面、手机保留表头、全部单元格与列数；复习状态不变')
})

check('复习查证: 编号开头、列表和因果图不丢失，跨篇依据可原地查阅', async () => {
  await page.goto(`${BASE}/p/caocao/01-wusebang`, { waitUntil: 'networkidle' })
  await enterStory()
  await page.locator('.next-bar').scrollIntoViewIfNeeded()
  await page.waitForSelector('.reader-after .card')
  const time = page.locator('.card').filter({ hasText: '这一篇里，时间给了几个刻度' })
  await time.getByRole('button', { name: /点开看答案/ }).click()
  const text = await time.innerText()
  if (!text.includes('单凭它定不了公元年份') || !text.includes('光和末')) return fail('编号开头的答案被吞掉')
  await resetLocal()
  await page.goto(`${BASE}/p/jingke/03-shouming`, { waitUntil: 'networkidle' })
  await enterStory()
  await page.locator('.next-bar').scrollIntoViewIfNeeded()
  await page.waitForSelector('.reader-after .card')
  const cause = page.locator('.card').filter({ hasText: '为什么要把国事交给' })
  await cause.getByRole('button', { name: /点开看答案/ }).click()
  if (!(await cause.locator('pre').innerText()).includes('秦欲不可足')) return fail('因果图丢失')
  await resetLocal()
  await page.goto(`${BASE}/p/jingke/08-weisheng`, { waitUntil: 'networkidle' })
  await enterStory()
  await page.locator('.next-bar').scrollIntoViewIfNeeded()
  await page.waitForSelector('.reader-after .card')
  const parallel = page.locator('.card').filter({ hasText: '荆轲那一击和高渐离那一击' })
  await parallel.getByRole('button', { name: /点开看答案/ }).click()
  const ref = parallel.locator('button.cite').filter({ hasText: '065' }).first()
  if (!(await ref.count())) return fail('跨篇依据 065 仍不可点')
  await ref.click()
  await page.waitForSelector('#src-065')
  if (!(await page.locator('#src-065').innerText()).includes('补充参照')) return fail('跨篇原文未说明补充性质')
  await page.locator('#src-065 button.back').click()
  if (await page.locator('#source-panel').isVisible()) return fail('查证返回后仍挡着复习答案')
  return ok('年龄依据、因果图与跨篇补充原文均完整可见，可返回原答案')
})

const todo = FILTER ? results.filter((r) => r.name.includes(FILTER)) : results
  console.log(`\n观史 · 浏览器验证${FILTER ? `（筛选：${FILTER}）` : ''}\n`)

  let failed = 0
  for (const { name, fn } of todo) {
    /* 起点要干净：上一条检查可能把阅读进度写进了 localStorage */
    await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {})
    await resetLocal()
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
