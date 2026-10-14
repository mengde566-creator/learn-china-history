#!/usr/bin/env node
/**
 * 逐字核对 source.md 和参考文本。
 *
 * **这是这个项目最要紧的一条检查。** 全部内容都建立在「原文是这样」之上，
 * 而原文一直是 AI 依记忆写的；在此之前全库「已核」段落是 0——
 * 不是没核，是**没有可核的东西**：没有底本、没有工具、也没人能复核结论。
 *
 * 参考文本由 `scripts/fetch-refs.mjs` 取到 `.refs/`（公版电子本，网址稳定）。
 * 哪个底本对哪一段，写在 `scripts/refs.json`。
 *
 * 用法：node scripts/check-sources.mjs [人物id]
 *
 * ⚠️ 它能证明的是「我们写的和这份文件一致」。
 *    它证明的是「本库写的和这份文件一致」。口径见 content/README.md 的「核对口径」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PEOPLE = path.join(ROOT, 'content', 'people')
const REFS = path.join(ROOT, '.refs')

const tw2cn = require('opencc-js').Converter({ from: 'tw', to: 'cn' })

/* 只留汉字。标点、空白、换行都不参与比对——
   参考文本按固定宽度折行，不剥掉的话每一段都会"对不上"。 */
const only = (t) => String(t).replace(/[^\u4e00-\u9fff]/g, '')

/* **两边走同一个转换。**
   参考文本一部分是繁体（Gutenberg 的《三國志》），一部分本来就是简体
   （GitHub 那份《刺客列传》）。给简体文本做繁转简会**改字**——
   「於期」会变成「于期」，于是本库写对的「樊於期」反而"对不上"。
   所以不比"谁转成了什么"，比的是"两边转完是不是同一个东西"。 */
const norm = (t) => only(tw2cn(t))

/* 从 `## 底本N · 档次 · 书名` 小节里把条目读出来。
   和 build-content.mjs 的 parseSource 是两套独立实现：
   用同一份的话，解析器错了这边跟着错，就白核了。 */
function readSource(rel, defaultBook) {
  const lines = fs.readFileSync(rel, 'utf8').split('\n')
  const out = []
  let book = null
  lines.forEach((line, i) => {
    const h = line.match(/^##\s*底本[^·]*·\s*([^·]+?)\s*·\s*(.+?)\s*$/)
    if (h) { book = { tier: h[1].trim(), book: h[2].trim() }; return }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3 || !/^\d{3}$/.test(cells[0])) return
    /* 只认真原文行：优先级那格必须是 A/B/C（四列表的话在第四格）。
       少了这一条，source.md 里别的表——比如「五段的结构」——
       会被当成原文拉进来一起比，凭空多出一堆"对不上"。 */
    const pri = (x) => String(x || '').replace(/\*\*|`/g, '').trim()
    let priority = cells[2]
    if (!/^[ABC]/.test(pri(priority))) priority = cells[3] ?? ''
    if (!/^[ABC]/.test(pri(priority))) return
    let text = cells[1]
    out.push({
      id: cells[0],
      book: book?.book || defaultBook || '(没有底本小节)',
      tier: book?.tier || '正史',
      text: text.replace(/★/g, '').replace(/`[^`]*`/g, '').trim(),
      line: i + 1,
    })
  })
  return out
}

const cache = new Map()
function slice(ref, from, to) {
  const key = `${ref}|${from}|${to}`
  if (cache.has(key)) return cache.get(key)
  const p = path.join(REFS, ref)
  if (!fs.existsSync(p)) throw new Error(`缺 .refs/${ref}——先跑 node scripts/fetch-refs.mjs`)
  /* HTML 参考文本：正文都在 <p> 里，先把标签剥掉再拼起来 */
  const raw = fs.readFileSync(p, 'utf8')
  const src = ref.endsWith('.html')
    ? [...raw.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ')).join('')
    : raw
  const flat = norm(src)
  /* 锚点也要过一遍繁转简：refs.json 里写的是书名/回目的原样，
     而上面刚把整份参考文本转成了简体，不转就对不上。 */
  const i = flat.indexOf(norm(from))
  if (i < 0) throw new Error(`.refs/${ref} 里找不到起始锚点「${from}」`)
  const j = to ? flat.indexOf(norm(to), i + 1) : -1
  const text = flat.slice(i, j < 0 ? undefined : j)
  cache.set(key, text)
  return text
}

/* 对不上时给点用得上的东西：最长公共前缀 + 参考文本那一带的原文。 */
function explain(needle, hay) {
  let lo = 0, hi = needle.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (hay.includes(needle.slice(0, mid))) lo = mid; else hi = mid - 1
  }
  const head = needle.slice(0, lo)
  const at = head ? hay.indexOf(head) : -1
  return {
    matched: lo,
    at,
    ref: at < 0 ? '' : hay.slice(Math.max(0, at - 20), at + needle.length + 20),
    diverged: needle.slice(lo, lo + 12),
  }
}

const only_ = process.argv[2]
const map = JSON.parse(fs.readFileSync(path.join(HERE, 'refs.json'), 'utf8'))
const people = fs.readdirSync(PEOPLE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && (!only_ || d.name === only_))
  .map((d) => d.name).sort()

let pass = 0, fail = 0, skip = 0
console.log('\n逐字核对 source.md ←→ .refs/\n')

for (const id of people) {
  const rel = path.join(PEOPLE, id, 'source.md')
  if (!fs.existsSync(rel)) continue
  /* 没写 `## 底本` 小节的人（荆轲），默认归 person.md「出处」那一本的正文 */
  const pm = path.join(PEOPLE, id, 'person.md')
  const dm = fs.existsSync(pm) && fs.readFileSync(pm, 'utf8').match(/\|\s*\*\*出处\*\*\s*\|\s*([^|]+?)\s*\|/)
  const entries = readSource(rel, dm && dm[1])
  const conf = map[id]
  console.log(`  ${id}  （${entries.length} 段）`)
  for (const e of entries) {
    const c = conf?.[e.book]
    if (!c) {
      skip++
      console.log(`    · ${e.id}  ${e.tier}　未配置参考文本（refs.json 里没有「${e.book}」）`)
      continue
    }
    let hay = slice(c.ref, c.from, c.to)
    /* 校勘：参考文本作 A，本库作 B，比对时按 B 算。
       每一次替换都必须在这里留一条——偷偷改字比错字更坏。 */
    for (const [refReads, weWrite] of (c.校勘 || [])) {
      hay = hay.split(norm(refReads)).join(norm(weWrite))
    }
    /* **按小句比对，不按整段，也不按整句。**
       《三國志》的电子本把裴松之注夹在正文句子中间——
       有时候夹在句与句之间，有时候夹在一个句子的两个分句之间
       （「冬十二月，始起兵于己吾，<注：世语曰…>是岁中平六年也。」）。
       按整段比一定对不上，按整句比也会漏掉后面那种。
       切到小句、每片至少 4 个字，就两头都盖住了。
       代价是很短的片段可能在参考文本里别处撞上——4 个字以下的碎片不查。 */
    const sentences = e.text.split(/[。！？；，、]/).map(norm).filter((x) => x.length >= 4)
    const bad = sentences.filter((x) => !hay.includes(x))
    if (!sentences.length) { skip++; console.log(`    · ${e.id}  读不出可比的句子`); continue }
    if (!bad.length) {
      pass++
      console.log(`    ✓ ${e.id}  ${e.tier}　逐字对得上（${sentences.length} 句）`)
    } else {
      fail++
      console.log(`    ✗ ${e.id}  ${e.tier}　${bad.length}/${sentences.length} 句对不上`)
      for (const b of bad.slice(0, 3)) {
        const d = explain(b, hay)
        console.log(`         前 ${d.matched} 字对得上，从「${d.diverged}…」岔开`)
        if (d.ref) console.log(`         参考：…${d.ref}…`)
      }
      console.log(`         本库：source.md:${e.line}`)
    }
  }
  console.log('')
}

console.log(`  对得上 ${pass} · 对不上 ${fail} · 跳过 ${skip}\n`)
if (fail) {
  console.log('  ✗ 有对不上的段落。改内容或者改 source.md，不要放着。\n')
  process.exitCode = 1
} else if (pass) {
  console.log('  ✓ 参考文本能覆盖的段落全部逐字一致。')
  console.log('    底本逐字与公版电子本一致。（核对口径见 content/README.md）\n')
}
