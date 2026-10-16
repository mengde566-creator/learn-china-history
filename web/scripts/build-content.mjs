#!/usr/bin/env node
/**
 * 观史 · 内容编译器
 * Markdown（人读的审校稿） → JSON（程序读的运行数据）
 *
 * 目录约定：
 *   content/people/<person>/
 *     person.md            人物：时代 / 出处 / 简介 / 关键时点
 *     source.md            原文底本
 *     stories.md           故事一览（id 对应 stories/<id>.md）
 *     cast.md              本篇人物的知识边界
 *     stories/<id>.md      故事内容
 *     seeds/<id>.md        对话种子
 *     cards/<id>.md        复习卡
 *
 * 单一数据源原则：content/ 下的 Markdown 是唯一的源，本脚本是唯一的转换出口。
 * 任何解析失败都会带着行号报错，绝不静默跳过。
 *
 * 用法：
 *   node scripts/build-content.mjs          编译到 data/content.json
 *   node scripts/build-content.mjs --check  只校验，不写文件
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
/* 原文范围的写法，和渲染层共用同一份实现（`lib/content.js` 也引它）。
   两边各写一份正则的话，编译器校验的和页面渲染的迟早不是同一件事。 */
import { parseRange } from '../lib/range.mjs'
import { citeOf } from '../lib/cite.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const CONTENT = path.join(ROOT, 'content')
const PEOPLE = path.join(CONTENT, 'people')
const OUT = path.join(ROOT, 'web', 'data')
const CHECK_ONLY = process.argv.includes('--check')

/* ── 工具 ───────────────────────────────────────── */

class ParseError extends Error {
  constructor(file, line, msg) {
    super(`\n  ✗ ${file}${line ? ':' + line : ''}\n    ${msg}\n`)
    this.name = 'ParseError'
  }
}

function read(rel) {
  const p = path.join(CONTENT, rel)
  if (!fs.existsSync(p)) throw new Error(`找不到内容文件：${rel}`)
  return { rel, path: p, lines: fs.readFileSync(p, 'utf8').split('\n') }
}

const exists = (rel) => fs.existsSync(path.join(CONTENT, rel))

/** 从一行里抽出结尾的独立标记，如 "那不是普通的白。 △"
 *
 *  ⚠️ 「—」要特别小心：行文里的破折号「——」也以它结尾。
 *  所以 — 要求前面有空白、且前一个字符不是「—」。
 */
function splitMarker(s) {
  let m = s.match(/^(.*?)\s+([◆○△])\s*$/)
  if (m) return { text: m[1].trim(), marker: m[2] }
  m = s.match(/^(.*?)\s+—\s*$/)
  if (m && !/—$/.test(m[1])) return { text: m[1].trim(), marker: '—' }
  return { text: s.trim(), marker: null }
}

/** 解析 | a | b | 形式的表格行 */
function tableRow(line) {
  if (!line.trim().startsWith('|')) return null
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  if (cells.every((c) => /^[-:]*$/.test(c))) return null // 分隔行
  return cells
}

/** 去掉 inline markdown 记号，供界面显示 */
function clean(s) {
  return String(s ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/g, '\n')
    .trim()
}

/**
 * 从文本里抽 3 位编号，如 `054` 或 054。
 *
 * **必须去重。** 引文核对有一档严格规则是「这一行只引了一个编号 → 该行所有
 * ≥6 字的引文都要命中它」。不去重的话，**把同一个编号在那一行写两遍**，
 * cited.length 就变成 2，严格档静默关闭——同一句伪造引文立刻全绿。
 * 审核员实测过：检查项 16799→16798，行数少一项，没有任何提示。
 * 一个"写两遍"就能关掉的闸门，等于没有。
 */
/* 从一行里抽出所有编号。**必须展开区间。**
   原来只做 `/`?(\d{3})`?/g`，于是 `` `040`–`045` `` 只取到 040 和 045——
   中间四段全丢。而引文核对用的是这个函数：一行写区间、引文落在区间中间，
   就会报「引文在 040 045 里找不到」（假红）；反过来，区间中间那几段里的
   真错误也查不出来（假绿）。全库 72 处这种写法。
   实测踩到的是 `08-guandu` 的复习卡：`040`–`045` 漏掉 044，
   而「大破琼等，皆斩之」正在 044 里。
   区间只在**两端都像编号、且跨度合理**时才展开，免得把年份范围当成编号。 */
const ids = (s) => {
  const t = String(s ?? '')
  const out = new Set()
  /* 反引号可以夹在数字和破折号之间：`` `040`–`045` `` —— 这是本库最常用的写法。 */
  for (const m of t.matchAll(/`?(\d{3})`?\s*[–—-]\s*`?(\d{3})`?/g)) {
    const a = Number(m[1]), b = Number(m[2])
    if (!(a >= 1 && b >= 1 && b > a && b - a <= 60)) continue
    /* 年份范围不是编号：「公元 189–191 年」。前后有「公元」或后面跟「年」就不展开。 */
    const before = t.slice(Math.max(0, m.index - 6), m.index)
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (/公元\s*$/.test(before) || /^\s*年/.test(after)) continue
    for (let i = a; i <= b; i++) out.add(String(i).padStart(3, '0'))
  }
  for (const m of t.matchAll(/`?(\d{3})`?/g)) out.add(m[1])
  return [...out]
}

/** 收集某个二级标题下的正文段落 */
function sectionParagraphs(lines, heading) {
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}`).test(l))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s/.test(l)) break
    if (!l.trim()) continue
    if (/^[|>#\-`]/.test(l.trim())) continue
    out.push(clean(l))
  }
  return out
}

/** 收集某个二级标题下的表格行（三列：时间 / 事件 / 故事） */
function sectionTable(lines, heading, minCols = 2) {
  const start = lines.findIndex((l) => new RegExp(`^##\\s*${heading}`).test(l))
  if (start < 0) return []
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    const c = tableRow(lines[i])
    if (c && c.length >= minCols && !/^(时间|行|项|#)$/.test(clean(c[0]))) out.push(c.map(clean))
  }
  return out
}

/* ── 图片资源 ───────────────────────────────────── */

/**
 * 把 content/people/<id>/assets/ 同步到 web/public/assets/<id>/，
 * 返回 文件名 → URL 的映射。
 *
 * 内容文件里只写文件名（如 `yishui-01.jpg`），不写路径——
 * 换部署方式、换目录结构都不用改内容。
 */
function syncAssets(personId) {
  const src = path.join(PEOPLE, personId, 'assets')
  if (!fs.existsSync(src)) return {}
  const dest = path.join(ROOT, 'web', 'public', 'assets', personId)
  fs.mkdirSync(dest, { recursive: true })

  const map = {}
  for (const f of fs.readdirSync(src)) {
    if (f.startsWith('.') || f === 'README.md') continue
    fs.copyFileSync(path.join(src, f), path.join(dest, f))
    map[f] = `/assets/${personId}/${f}`
  }
  return map
}

/** 把内容里写的文件名解析成 URL。空 / 「—」= 没有图，不算错。 */
function resolveImg(name, assets, warn, where) {
  const n = String(name ?? '').trim().replace(/`/g, '')
  if (!n || n === '—' || n === '-') return null
  if (!assets[n]) {
    warn.push(`${where}：找不到图片 assets/${n}`)
    return null
  }
  return assets[n]
}

/* ── person.md ──────────────────────────────────── */

function parsePersonMeta(rel) {
  const { lines } = read(rel)
  const name = clean((lines.find((l) => /^#\s/.test(l)) || '# 未命名').replace(/^#\s*/, ''))
  const meta = {}
  for (const l of lines) {
    const c = tableRow(l)
    if (c && c.length >= 2 && c[0] && c[1]) meta[clean(c[0]).replace(/\*\*/g, '')] = clean(c[1])
  }
  const timeline = sectionTable(lines, '关键时点', 3).map((c) => ({
    time: c[0], event: c[1], story: c[2] ?? '',
  }))

  return {
    name,
    era: meta['时代'] || '未分期',
    died: meta['卒年'] || null,
    sourceBook: meta['出处'] || null,
    /* 人物页用的底本范围。故事早就有「原文」范围，人物页一句都没有——
       于是曹操的引子讲了七件底本里没有的事（`source.md` 那时只有 4 段，
       全是刺董那一刻），谁都不报错。README 里「没有原文编号支撑的陈述
       不能进产品」这条一直写着，缺的是机制；这个字段就是机制。
       不渲染，只给编译器查。 */
    sourceRange: meta['底本'] || null,
    storyCountLabel: meta['故事'] || null,
    imgFile: meta['画像'] || null,
    intro: sectionParagraphs(lines, '他是谁'),
    why: sectionParagraphs(lines, '为什么读他'),
    timeline,
  }
}

/* ── source.md ──────────────────────────────────── */

/* 底本的档次。一个人可以有好几本：正史正文、注家引的别史、小说、野史。
   曹操就是四本——这正是「曹操刺董」这个篇名能被回答的原因：
   正史里没有那一刀，演义里有。 */

const TIERS = ['正史', '注', '小说', '野史']

/* 编号按底本分号段，光看号码就知道是哪一档：
     0xx  正史正文
     1xx  注（裴松之引的别史）
     2xx  小说
     3xx  野史
   这样「引用 201」在 Markdown 里一眼就不是正史，
   不会像原来那样，裴注的 004 和正文的 003 挤在一条序列上。 */
/* 号段：正史 001–199、注 201–399、小说 401–599、野史 601–799。
   **2026-10-15 从「每档 100 个位置」加宽到 200**——《武帝纪》全收要
   112 段正文 ＋ 111 段注，100 个位置装不下。再长的本纪（南北朝那些动辄两万字）
   还可能要加宽，但那是以后的事。 */
const bandOf = (id) => {
  const n = Number(id)
  return n <= 199 ? 0 : n <= 399 ? 1 : n <= 599 ? 2 : n <= 799 ? 3 : 9
}

function parseSource(rel, fileLabel, defaultBook) {
  const { lines } = read(rel)
  const source = {}
  let book = defaultBook || '未署名的底本'
  let tier = '正史'

  lines.forEach((line, i) => {
    /* `## 底本一 · 正史 ·《史记·刺客列传》`
       不写底本小节的行，默认归 person.md「出处」那一本的正文——
       荆轲的 source.md 一个小节都没有，照旧。 */
    const h = line.match(/^##\s*底本[^·]*·\s*([^·]+?)\s*·\s*(.+?)\s*$/)
    /* 写了个「## 底本」，但三段没写全——**必须报错，不能当没看见**。
       原来只在正则匹配上时才处理，于是 `## 底本三 · 小说` 这种半截标题
       会被静默跳过：后面那些行悄悄挂在上一本底本下面，书名丢了，
       号段校验也绕过去了，编译还是一片绿。
       书名是读者判断「这句该不该信」的唯一依据，不能允许它可有可无。 */
    if (!h && /^##\s*底本/.test(line)) {
      throw new ParseError(rel, i + 1,
        '底本小节的标题写不全。必须是「## 底本<序号> · <档次> ·《书名>」三段——' +
        `现在这一行是「${line.trim()}」。` +
        `（档次只认 ${TIERS.join(' / ')}；书名不能省，界面上要拿它标出处）`)
    }
    if (h) {
      const t = h[1].trim()
      if (!TIERS.includes(t)) {
        throw new ParseError(rel, i + 1,
          `底本档次「${t}」不认识。只认 ${TIERS.join(' / ')}——` +
          '写成「## 底本一 · 正史 ·《某某书》」')
      }
      tier = t
      book = h[2].trim()
      return
    }

    const cells = tableRow(line)
    if (!cells || cells.length < 3) return
    if (!/^\d{3}$/.test(cells[0])) return

    const id = cells[0]
    const rawText = cells[1]
    /* 表可以是三列（编号 | 原文 | 优先级），也可以是四列
       （编号 | 原文 | 出处 | 优先级）——同一本底本里各条出自不同的书时要用四列，
       比如裴松之注引的那三条分别出自《异同杂语》和《曹瞒传》。
       判据是"第三格像不像优先级"，像就当三列读。 */
    let rowNote = null
    let priority = cells[2]
    if (!/^[ABC]/.test(String(priority).replace(/\*\*/g, '').trim())) {
      rowNote = clean(cells[2])
      priority = cells[3] ?? ''
    }
    if (!/^[ABC]/.test(String(priority).replace(/\*\*/g, '').trim())) return

    /* 行内的 `注 · …`：四列表已经能说清出处，这个留给三列表偶尔要补一句的情况。 */
    const NOTE = /`注(?:\s*·\s*([^`]+))?`/
    const noteM = rawText.match(NOTE)

    if (source[id]) {
      throw new ParseError(rel, i + 1, `编号 ${id} 出现了两次——同一本底本里编号必须唯一`)
    }
    const BAND_OF_TIER = { 正史: 0, 注: 1, 小说: 2, 野史: 3 }
    if (bandOf(id) !== BAND_OF_TIER[tier]) {
      throw new ParseError(rel, i + 1,
        `编号 ${id} 落在「${TIERS[bandOf(id)]}」号段（${bandOf(id) * 100}xx），` +
        `可它现在挂在「${tier}」这一本底下。号段和底本档次必须对得上：` +
        '正史 001–199、注 201–399、小说 401–599、野史 601–799')
    }

    source[id] = {
      id,
      book,
      tier,
      /* 引用时显示哪一行字。规则在 `lib/cite.mjs`——**和 new-story.mjs 共用一份**：
         那边自己算过一份不一样的，结果骨架生成器生成的文件被闸门当场拒绝。
         （2026-10-14 用户问：「你要是引的三国演义就应该标记三国演义」） */
      origin: citeOf({ tier, book, note: rowNote || (noteM ? (noteM[1] || '注').trim() : null) }),
      line: i + 1,
      text: rawText.replace(/★/g, '').replace(/`异文`/g, '').replace(NOTE, '').trim(),
      priority: String(priority).replace(/\*\*/g, '').trim()[0],
      key: /★/.test(rawText),
      variant: /异文/.test(rawText) || /异文/.test(priority),
      compressed: /压缩/.test(priority),
    }
  })

  const n = Object.keys(source).length
  if (n === 0) throw new ParseError(fileLabel, 0, '没有解析出任何原文段落')

  /* 底本得有个名字。名字从两个地方来：`## 底本` 小节的书名，
     或者 person.md「出处」那一行（没有小节时全篇归它）。
     两个都没有，就会掉进「未署名的底本」这个兜底——
     而那句话会原样印到「原文」面板的分节标题上。
     底本是读者判断「这句该不该信」的唯一依据，不能没有名字。 */
  const nameless = Object.values(source).filter((s) => !s.book || /未署名/.test(s.book))
  if (nameless.length) {
    throw new ParseError(fileLabel, nameless[0].line,
      `原文 ${nameless[0].id} 的底本没有名字（现在写作「${nameless[0].book}」）。` +
      '两种写法选一个：在 source.md 里写「## 底本一 · 正史 ·《某某书》」，' +
      '或者在 person.md 的表里填「| **出处** | 《某某书》 |」。' +
      '界面上会把书名印在「原文」面板的分节标题里，不能空着')
  }
  return source
}

/* ── stories.md：故事一览 ───────────────────────── */

function parseStoryList(rel) {
  const { lines } = read(rel)
  const start = lines.findIndex((l) => /^##\s*故事一览/.test(l))
  if (start < 0) throw new ParseError(rel, 0, '找不到「## 故事一览」小节')

  const list = []
  let stage = null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s/.test(l)) { end = i; break }
    /* 「### 阶段名」把故事一览再分组（曹操那种几十篇的人物要用）。
       用三级标题，因为二级标题在「故事一览」这里意味着这一节结束了。 */
    const h = l.match(/^###\s+(.+?)\s*$/)
    if (h) { stage = h[1]; continue }
    const c = tableRow(l)
    if (!c || c.length < 5) continue
    const id = clean(c[0])
    // id 约定为「两位序号-短名」（如 06-yishui），也就是故事文件名。
    // 用严格正则，表头行（id | 故事 | …）就不会被当成一条故事。
    /* 三位数的 id（`100-xxx`）原来在这里被 `continue` **静默跳过**——
       写进故事一览，编译一条错误都不报，只在文件已存在时冒出一句
       「没有登记」。那是这个项目最怕的一类失败：东西丢了，没人知道。 */
    if (/^\d+-[a-z0-9-]+$/i.test(id) && !/^\d{2}-[a-z0-9-]+$/i.test(id)) {
      throw new ParseError(rel, i + 1,
        `故事 id「${id}」不合规。id 是「两位序号-短名」（如 06-yishui）——` +
        '两位数是硬限制，`100-` 开头的写法读不进来')
    }
    if (!/^\d{2}-[a-z0-9-]+$/i.test(id)) continue
    list.push({
      id,
      line: i + 1,
      stage,
      name: clean(c[1]),
      question: clean(c[2]),   // 兼容旧列名
      scene: clean(c[2]),
      turningPoint: clean(c[3]),
      time: clean(c[4]),
      sourceRange: clean(c[5] ?? ''),
      duration: clean(c[6] ?? ''),
      statusLabel: clean(c[7] ?? ''),
    })
  }

  /* 地雷：README 原来教人用「## 阶段名」分段，而二级标题在这里是"这一节结束"。
     照它写，阶段里的故事会**一条都不进列表，而且不报错**——实测过，
     校验还报"全部通过"。这里把那种写法拦下来。

     拦的是"小节之后还挂着故事条目"，所以认的是**外形**，不是"单元格正好等于 id"：
       · 表格首列以 id 开头即可（`` `03-chenliu` 待写 `` 也要抓）
       · 项目符号列表里出现 id 也抓（有人会用列表分行写）
     代价是"故事一览之后再放一张正经索引表"会误报。这是有意选的：
     误报看得见、改一下就好，静默丢八篇看不见。报错里写了怎么绕开。 */
  const ID_TOKEN = /\b\d{2}-[a-z0-9-]{2,}\b/i
  const orphan = []
  for (let i = end; i < lines.length; i++) {
    const l = lines[i]
    const c = tableRow(l)
    if (c && ID_TOKEN.test(clean(c[0]))) { orphan.push(clean(c[0]).slice(0, 24)); continue }
    if (/^\s*(?:[-*+]|\d+\.)\s+\S/.test(l) && ID_TOKEN.test(l)) orphan.push(l.trim().slice(0, 24))
  }
  if (orphan.length) {
    throw new ParseError(rel, end + 1,
      `「## 故事一览」之后还有 ${orphan.length} 条故事（${orphan.slice(0, 3).join('、')}…），` +
      '它们不会被读进来。分组请用「### 阶段名」，写在「## 故事一览」里面；' +
      '如果那本来就是一张索引表、不是故事分组，把它挪到别的小节')
  }

  if (!list.length) throw new ParseError(rel, 0, '故事一览表是空的')

  /* ── 两道顺序闸门 ─────────────────────────────
     这张表是**读者读的顺序**，而文件是按 id 排序的。两者不一致时，
     页面上的顺序和 id 顺序打架，谁也不会报错。
     2026-10-14 就是这么被打回来的：曹操的「五色棒」是 174 年的事，
     「刺董」是 189 年，表里却把刺董排在前面——因为那一行是先写的。
     （同一天补的 `scripts/renumber.mjs` 会警告行序，但它只是个工具，
     人不看它的输出就白搭；闸门在编译器里才算数。） */

  /* 一、id 必须顺着排。
     重编号工具改了文件名和字样，行序还是旧的——这是它最容易留下的坑。 */
  for (let i = 1; i < list.length; i++) {
    if (list[i].id < list[i - 1].id) {
      throw new ParseError(rel, list[i].line,
        `故事一览里的行序和编号对不上：${list[i - 1].id}（第 ${list[i - 1].line} 行）` +
        `后面跟着 ${list[i].id}。\n` +
        '    编号被约定为阅读顺序的次序号（文件按 id 排、链接按 id 找），' +
        '行序才是读者看到的顺序。两者打架，说明这次改编号只改了一半——' +
        '多半是 `renumber.mjs` 改完文件、忘了把这一行挪到该在的位置。')
    }
  }

  /* 二、同一个分组里，时间要么递增，要么就别写成能干瞪眼比较的形式。
     「同年」「前 227」「前 232 – 前 228」这类写法这里一律跳过——
     年代本身还没核过（荆轲那一页写着「需另行核对」），
     拿没核实的文字做判据，闸门迟早会误报。只拦一眼能看出的倒序：
     纯数字的公元年份。曹操那十篇全部落在这一档，够用了。 */
  const bareYear = (t) =>
    { const m = String(t).replace(/\*\*/g, '').trim().match(/^(?:公元)?\s*(\d{3,4})\s*年?$/)
      return m ? Number(m[1]) : null }
  let prev = null
  for (const s of list) {
    const y = bareYear(s.time)
    if (s.stage !== prev?.stage) { prev = null }   // 换了分组，不跨组比
    if (y === null) { prev = { stage: s.stage, y: null, s }; continue }
    if (prev && prev.y !== null && y < prev.y) {
      throw new ParseError(rel, s.line,
        `「${s.stage || '（未分组）'}」这一组里时间是倒着的：${prev.s.id} 是 ${prev.y} 年，` +
        `后面 ${s.id} 却是 ${y} 年。\n` +
        '    故事一览就是读的顺序，按时间排。要改编号就先用 ' +
        '`node scripts/renumber.mjs <人物> 旧id=新id`，再把这一行挪到该在的位置')
    }
    prev = { stage: s.stage, y, s }
  }

  return list
}

/* ── stories/<id>.md：故事内容 ──────────────────── */

function parseStoryContent(rel, source) {
  const { lines } = read(rel)

  /* 第一行是篇名。曹操那几篇写成 `# 02-cidong · 曹操刺董`，
     荆轲那几篇写成 `# 燕国危局`——两种都认，去掉可能存在的 id 前缀。
     这个名字以前**没人读**：页面上的篇名一律来自 `stories.md`。
     于是把故事一览的篇名改成另一篇的名字，编译全绿，
     读者看到「曹操刺董」那张卡，点进去是五色棒。 */
  const h1 = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s*/, '').trim()
  const h1Title = h1 ? h1.replace(/^\d{2}-[a-z0-9-]+\s*·\s*/i, '').trim() : null

  const story = {
    intro: { lines: [], basis: [], note: '' },
    beats: [],
    backgrounds: [],
    groundTable: [],
    present: [],
    /* title 和 declaredRange 从前**根本没人读**：文件第一行的篇名、
       前表里的「| **原文** |」那一行，都是装饰。谁改都不会响——
       而页面上的篇名只来自 stories.md，改错了读者看到的就是另一篇的名字。
       现在读进来，交给 validateContent 和 stories.md 对账。 */
    title: h1Title,
    declaredRange: null,
    imgFile: null,
    imgCaption: null,
    place: null,
  }

  let section = null
  let beat = null
  let bg = null
  let inIntroCode = false
  const beatHeadings = []

  const flushBeat = () => {
    if (!beat) return
    delete beat.tableSeen
    if (!beat.prose.length) throw new ParseError(rel, 0, `第 ${beat.n} 段没有正文`)
    if (!beat.marker) throw new ParseError(rel, 0, `第 ${beat.n} 段缺少「标记」行`)
    /* 正文里**逐字**嵌进来的原文，渲染时抽出来单独成块，挂「《史记》原文」的牌子。
    
       判别标准不是「有没有引号」——白话对白也带引号，而且大量是整行引号。
       曾经用 /[「『]/ && /[」』]/ 判，结果 49 行独立引文里 45 行是白话，
       全被挂到了「原文」标题底下。读者说「标记了原文又用了翻译」，
       指的就是这个。
    
       标准只能是「和底本对不对得上」：整行是引号，且归一化后能逐字找到。

       找的范围是**该段「原文」∪「依据」两栏的全部编号**。原来只看「原文」栏那一个，
       而台词经常出自「依据」栏的别的段落——抽查 8 处有 6 处如此，
       01 的段 8/9/10 更是分别出自 010/013/015。只看一个会漏掉真原文。 */
    beat.sources = [...new Set(
      ((beat.source || '') + ' ' + (beat.ground || '')).match(/\b\d{3}\b/g) || []
    )].filter((id) => source[id])
    /* 引文与它的白话回译。
       回译写成紧跟引文之后、以「——」开头的一行
       （06 段 5 的「——始终没有回头。」就是这个形状）。
       两条都记下**在 prose 里的下标**：渲染时要放回原位。
       早先把引文统一抽到段末，回译就会跑到引文前面去。 */
    beat.quotes = []
    beat.prose.forEach((p, i) => {
      const t = p.trim()
      /* 整行是引号，**后面还可以拖一个句号**——`「……终已不顾」` 和
         `「……终已不顾」。` 都是引文。只认"引号正好收在行尾"的话，
         补个句号就从引文掉成白话，「原文」牌子和白话回译一起消失，校验还全绿。
         归一化本来就把标点去掉了，所以只放宽形状、不改判据。 */
      if (!/^[「『][\s\S]*[」』][。！？；，、：]*$/.test(t)) return
      const n = normalizeQuote(t)
      if (n.length < 6) return
      if (!beat.sources.some((id) => normalizeQuote(source[id].text).includes(n))) return
      const next = (beat.prose[i + 1] || '').trim()
      const gloss = /^——/.test(next) ? next.replace(/^——\s*/, '') : null
      beat.quotes.push({ text: p, at: i, gloss, glossAt: gloss ? i + 1 : null })
    })
    story.beats.push(beat)
    beat = null
  }
  const flushBg = () => { if (bg) { story.backgrounds.push(bg); bg = null } }

  lines.forEach((line, i) => {
    // 标题下方的元数据（封面、地点等）——还没有进入任何 ## 小节
    if (section === null) {
      const cells = tableRow(line)
      if (cells && cells.length >= 2) {
        const k = clean(cells[0])
        if (k === '封面') story.imgFile = clean(cells[1])
        if (k === '图注') story.imgCaption = clean(cells[1])
        if (k === '地点') story.place = clean(cells[1])
        if (k === '原文') story.declaredRange = clean(cells[1])
      }
    }
    /* 进入任何新的 `##` 小节，都先把待收的情节点和背景卡收掉。
       原来只有「## 三、」调了 flushBeat()，其余几节只调 flushBg()——
       一篇故事如果从情节点直接跳到「## 四、背景卡」（没有对话种子那一节），
       **最后一段会被静默丢掉**。曹操那篇就是这么丢了第 4 段：
       文件里写着 4 个情节点，编译器只收到 3 个，而且不报错。 */
    const enter = (name) => { flushBeat(); flushBg(); section = name }
    if (/^## 一、/.test(line)) return enter('intro')
    if (/^## 二、/.test(line)) return enter('beats')
    if (/^## 三、/.test(line)) return enter('skip')
    if (/^## 四、/.test(line)) return enter('bg')
    if (/^## 五、/.test(line)) return enter('ground')
    if (/^## 六、/.test(line)) return enter('present')
    if (/^## 七、/.test(line)) return enter('skip')

    if (section === 'intro') {
      if (/^```/.test(line)) { inIntroCode = !inIntroCode; return }
      if (inIntroCode) {
        const raw = line.replace(/\s+←\s*/, '  ←  ').trimEnd()
        if (raw.trim()) {
          const arrow = raw.indexOf('←')
          story.intro.lines.push(
            arrow > -1
              ? { text: raw.slice(0, arrow).trim(), marker: raw.slice(arrow + 1).trim() }
              : { text: raw.trim(), marker: null }
          )
        }
      } else {
        /* fence 之后的「### 逐行依据」表。01/02/08 的 fence 不带内联标记，
           依据只在这张表里；不捕获它，门口那张依据卡右列会整片空白 */
        const cells = tableRow(line)
        if (cells && cells.length >= 3 && clean(cells[0]) !== '行') {
          story.intro.basis.push({ line: clean(cells[0]), marker: clean(cells[1]), basis: clean(cells[2]) })
        }
      }
      return
    }

    if (section === 'beats') {
      const h = line.match(/^### 情节点 (\d+) · (.+)$/)
      /* 情节点标题漏写编号，是最难发现的一类丢段：
         「### 情节点 · 东归」不像标题，会被当成上一段的正文——
         第 3 段的白话并进第 2 段，段数少一个，而校验报"全部通过"。
         标题在这个小节里只可能是情节点，形状不对就直接报错。 */
      if (/^###/.test(line)) {
        beatHeadings.push(line)
        if (!h) {
          throw new ParseError(rel, i + 1,
            `情节点标题写成「${line.trim()}」了，读不出来。要写成「### 情节点 3 · 东归」——编号、「·」、小标题三样都不能少`)
        }
      }
      if (h) {
        flushBeat()
        beat = { n: Number(h[1]), title: h[2].trim(), prose: [], marker: null, source: null, sourceText: null, ground: null, sources: [], quotes: [], tableSeen: false }
        return
      }
      if (!beat) return
      if (line.startsWith('> ')) {
        // 元数据表之后的内容是编辑批注，不是正文
        if (beat.tableSeen) return
        const { text, marker } = splitMarker(line.slice(2))
        if (marker) beat.marker = marker
        if (text) beat.prose.push(clean(text))
        return
      }
      const cells = tableRow(line)
      if (cells && cells.length >= 2) {
        beat.tableSeen = true
        const k = cells[0]
        if (k === '标记') { beat.marker = clean(cells[1]); return }
        if (k === '图') { beat.imgFile = clean(cells[1]); return }
        if (k === '图注') { beat.imgCaption = clean(cells[1]); return }
        if (k === '原文') {
          const id = ids(cells[1])[0]
          beat.source = id || null
          beat.sourceText = source[id]?.text ?? null
          /* 原始那一格留着给校验用——见下面「原文栏的文字必须和编号对得上」 */
          beat.sourceCell = clean(cells[1])
        }
        if (k === '依据') beat.ground = clean(cells[1])
      }
      return
    }

    if (section === 'bg') {
      const h = line.match(/^### (.+?)(?:\s+([◆◇○△—]))?\s*$/)
      if (h) { flushBg(); bg = { name: h[1].trim(), marker: h[2] || null, body: [], basis: null, imgFile: null, imgCaption: null }; return }
      if (!bg) return
      if (line.startsWith('> ')) {
        const raw = line.slice(2)
        if (/^\*\*依据\*\*/.test(raw)) { bg.basis = clean(raw.replace(/^\*\*依据\*\*：?/, '')); return }
        if (/^\*\*图\*\*/.test(raw)) { bg.imgFile = clean(raw.replace(/^\*\*图\*\*：?/, '')); return }
        if (/^\*\*图注\*\*/.test(raw)) { bg.imgCaption = clean(raw.replace(/^\*\*图注\*\*：?/, '')); return }
        const t = clean(raw); if (t) bg.body.push(t)
        return
      }
      if (line.trim() && !/^[|#\-`]/.test(line.trim())) bg.body.push(clean(line))
      return
    }

    if (section === 'ground') {
      const cells = tableRow(line)
      /* 表头那一行跳过。列名换过两次：早先叫「场景中的陈述」，但表里一直
         混着场景没写进去的行（「—」是明确不回答的，「◆ 注」是注解级的），
         所以改叫「本篇的说法」。三种写法都认，免得改一次列名就报一次
         「标记『标记』无效」。 */
      if (cells && cells.length >= 3 && !/^(场景中的陈述|本篇的说法|陈述|说法)$/.test(clean(cells[0]))) {
        story.groundTable.push({ claim: clean(cells[0]), marker: clean(cells[1]), basis: clean(cells[2]) })
      }
      return
    }

    if (section === 'present') {
      const cells = tableRow(line)
      if (cells && cells.length >= 3 && !/^人物$/.test(clean(cells[0]))) {
        const state = clean(cells[2])
        story.present.push({
          name: clean(cells[0]),
          role: clean(cells[1]),
          state,
          here: /^在场/.test(state.replace(/\*\*/g, '')),
        })
      }
    }
  })

  if (!story.beats.length) throw new ParseError(rel, 0, '没有解析出任何情节点')

  /* 文件里写了几个「### 情节点」标题，就必须收到几个情节点。
     这一条守的是解析器的静默丢段：小节切换时没有收尾，最后一段会不声不响
     地消失——曹操那篇丢过第 4 段，页面上少一段，谁都不报错。

     只数**情节点小节里**的标题，不数全文件：设计说明（## 七、）里引用一个
     标题样板是正常写法，不该被算进来。 */
  const declared = beatHeadings.length
  if (declared !== story.beats.length) {
    throw new ParseError(rel, 0,
      `情节点小节里有 ${declared} 个「### 情节点」标题，只收到 ${story.beats.length} 段——解析器丢了段落`)
  }
  return story
}

/* ── seeds/<id>.md ──────────────────────────────── */

/**
 * 种子／复习卡的标题里那个序号，必须等于文件名里的序号。
 *
 * 这两个标题界面上一律不渲染，所以**谁改都不会响**——可它们是作者回头找东西时
 * 唯一的路标。加这条闸门时实测已有三处对不上：
 * 曹操的 `seeds/02-cidong.md`、`cards/02-cidong.md` 写着「场景 01」（改编号时漏的），
 * 荆轲的 `cards/06-yishui.md` 写着「# 05 · 复习卡」（一开始就写错的）。
 * 三处都是子智能体审核扫出来的——人眼扫不到，因为没人会去看第一行。
 */
function checkOwnNumber(rel, id) {
  const { lines } = read(rel)
  const want = id.slice(0, 2)
  const h1 = (lines.find((l) => /^#\s/.test(l)) || '').trim()
  if (!h1) throw new ParseError(rel, 1, '第一行必须是标题，标题里要带这一篇的序号')
  if (!h1.match(/\b(\d{2})\b/)) {
    throw new ParseError(rel, 1,
      `标题里没有序号：「${h1}」。写成「# 对话种子 · 场景 ${want} · 篇名」这种形式——` +
      '标题不渲染，它是回头找东西时唯一的路标')
  }
  /* **查全篇，不只第一行。** 第一版只查 H1，于是
     `cards/02-cidong.md` 里那个「## 场景 01 · 曹操刺董（8 张）」漏了过去——
     文件是 02，H1 也早改成了 02，就中间那个二级标题还写着 01。
     凡是「场景 NN」「故事 NN」这种自带序号的说法，都得和文件名对得上。 */
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?:场景|故事)\s*(\d{2})(?!\d)/g)) {
      if (m[1] !== want) {
        throw new ParseError(rel, i + 1,
          `这一行里的序号和文件名对不上：文件是 ${id}.md（第 ${want} 篇），` +
          `写的却是「${line.trim().slice(0, 30)}」。界面上不渲染，所以错了没人看得见`)
      }
    }
  })
}

function parseSeeds(rel) {
  const { lines } = read(rel)
  const USER_FIELDS = new Set(['依据', '备注'])
  const seeds = []
  let group = null
  let seed = null
  let inCode = false

  const flush = () => { if (seed) { seeds.push(seed); seed = null } }

  lines.forEach((line, i) => {
    const ln = i + 1
    /* **分组编号要认到十。** 原来是 `[一二三四五六]`——只认到六，
       于是「七、」「八、」「九、」的分组标题被**静默忽略**，那些种子落进上一个
       匹配到的组里。而 `SeedSheet` 直接把 `group` 印给读者看：
       实测 `04-xingyang` 印成「边界外的提问 · 18」（实际是边界外 8 ＋ 系统层 10），
       `05-yanzhou` 印成「青州黄巾 · 21」（实际是 5 ＋ 7 ＋ 9）。
       **读者看到的是产品说明混在史料提问里。** */
    const g = line.match(/^## ([一二三四五六七八九十]+、[^（(]+)/)
    if (g) { flush(); group = g[1].trim(); return }
    if (/^## (统计|写作规则|文件格式)/.test(line)) { flush(); group = null; return }

    const q = line.match(/^\*\*Q(?:（[^）]*）)?：(.+?)\*\*$/)
    if (q) {
      flush()
      if (!group) throw new ParseError(rel, ln, '问题出现在任何分组之外')
      seed = { group, q: q[1].trim(), answer: [], sys: null, marker: null, meta: [], internal: null }
      return
    }
    if (!seed) return

    if (/^```/.test(line)) { inCode = !inCode; return }
    if (inCode) {
      if (line.trim()) seed.sys = (seed.sys ? seed.sys + '\n' : '') + line.trim()
      return
    }

    if (line.startsWith('> ')) {
      const { text, marker } = splitMarker(line.slice(2))
      if (marker) seed.marker = marker
      if (text) seed.answer.push(clean(text))
      return
    }

    /* 「标记」行。**原来只认「| 标记 | ○ |」这一种写法**——
       写成「| 标记 | ○ 外证 |」时正则匹配不上，这一行掉到下面的通用分支，
       被 `if (k === '标记') return` 静静吞掉：种子没有标记、界面不显示徽章、
       编译一路全绿。而图例恰恰在教作者写「○ 后面跟一个小字」，
       映射表和复习卡里也都是那个写法。**编译器在罚它自己教的写法。**
       现在按 `markerOf` 取第一个字符，取不出标记就直接报错，不再静默。 */
    const markerRow = line.match(/^\|\s*标记\s*\|\s*(.*?)\s*\|\s*$/)
    if (markerRow) {
      const g = markerOf(markerRow[1])
      if (!VALID_MARKERS.has(g)) {
        throw new ParseError(rel, ln,
          `「标记」行读不出标记：「${markerRow[1]}」。只能是 ` +
          `${[...VALID_MARKERS].join(' ')} 里面的一个，后面可以跟小字（像「○ 外证」）`)
      }
      seed.marker = g
      return
    }

    const cells = tableRow(line)
    if (!cells || cells.length < 2) return
    const k = clean(cells[0])
    const v = clean(cells[1] ?? '')
    if (k === '标记') return
    if (k === '内部') { seed.internal = v; return }
    if (USER_FIELDS.has(k)) { seed.meta.push({ k, v }); return }
    seed.internal = seed.internal ? seed.internal + '\n' + v : v
  })
  flush()

  const LEAK = /原稿|已改|已修正|是错的|一字不可改/
  const leaks = seeds.filter((s) => s.meta.some((m) => LEAK.test(m.v)))
  if (leaks.length) {
    throw new ParseError(rel, 0,
      `以下种子的「依据/备注」里混入了审校批注（应移入「内部」或审校记录）：\n    ${leaks.map((s) => s.q).join('、')}`)
  }
  /* 「### 标记分布」那张表：**编译器能数，就该数。**
     它原来没有任何校验，全库 12 份种子里的数字只能靠人眼——
     实测栽过两次：02-cidong 整张表没有（没人发现），
     08-guandu 的表把同一条算了两遍（◆写 5、实际 4）。
     而 ⓘ 那次迁移又把 9 份表变成了旧的。
     键取字形：`○ 合理推演` 和 `○ 外证` 都算 `○` 这一档（分两行写没关系，合计要对）。 */
  /* 围栏里的 ⓘ 不过 `clean()`（它进的是 sys，不是回答行），所以那里的 `**`
     会经 RichText 渲染成粗体——**和「粗体不渲染」这个决定不一致**。
     在这里统一剥掉。反引号留着：`` `013` `` 渲染成 <code> 是想要的。 */
  for (const sd of seeds) {
    if (sd.sys) sd.sys = sd.sys.replace(/\*\*(.+?)\*\*/g, '$1')
  }

  seeds.dist = {}
  const di = lines.findIndex((l) => /^###\s*标记分布/.test(l))
  if (di > -1) {
    for (let k = di + 1; k < lines.length; k++) {
      const l = lines[k]
      if (/^##\s/.test(l) && !/^###/.test(l)) break
      const c = tableRow(l)
      if (!c || c.length < 2) continue
      const g = markerOf(clean(c[0]))
      const num = Number(String(clean(c[1])).replace(/[^\d]/g, ''))
      if (VALID_MARKERS.has(g) && Number.isFinite(num)) seeds.dist[g] = (seeds.dist[g] || 0) + num
    }
  }

  return seeds
}

/* ── cards/<id>.md ──────────────────────────────── */

function parseCards(rel) {
  const { lines } = read(rel)
  const META_KEYS = new Set(['依据', '标记', '出处', '考点', '说明', '题型', '来源', '复习节奏'])
  const cards = []
  let card = null
  let blocks = []
  let table = null

  const pushTable = () => { if (table) { blocks.push(table); table = null } }
  const flush = () => {
    if (!card) return
    pushTable()
    card.blocks = blocks.filter((b) => (b.t === 'p' ? b.v.trim() : b.rows.length))
    if (card.q && card.blocks.length) cards.push(card)
    card = null
    blocks = []
  }

  lines.forEach((line) => {
    const h = line.match(/^### 卡 (\d+) · (.+?)(?:\s*[★⚠️]+)?\s*$/)
    if (h) { flush(); card = { n: Number(h[1]), type: h[2].trim(), q: null, blocks: [], meta: [] }; return }
    if (!card) return
    if (/^## /.test(line)) { flush(); return }

    const q = line.match(/^\*\*问：(.+?)\*\*$/)
    if (q) { pushTable(); card.q = clean(q[1]); return }

    if (line.startsWith('答：')) { pushTable(); blocks.push({ t: 'p', v: clean(line.slice(2)) }); return }

    if (line.startsWith('>')) {
      const t = clean(line.replace(/^>\s?/, ''))
      if (t) { pushTable(); blocks.push({ t: 'p', v: t }) }
      return
    }

    const cells = tableRow(line)
    if (cells) {
      if (META_KEYS.has(clean(cells[0]))) {
        pushTable()
        const k = clean(cells[0])
        const v = clean(cells[1] ?? '')
        card.meta.push({ k, v })
        /* 卡片也有标记，而且**从这条路取出来**。
           原来「标记」只进 meta，`card.marker` 永远是 undefined：
           界面上没有徽章（读者看到的是一行光秃秃的「标记 ◆ 出自原文」），
           而且「卡片必须有标记」这条闸门根本无从写起——
           `cards/06-yishui.md` 的卡 8 整个没有标记行，编译一路全绿。 */
        if (k === '标记') {
          const g = markerOf(v)
          if (!VALID_MARKERS.has(g)) {
            throw new ParseError(rel, ln,
              `复习卡的「标记」行读不出标记：「${v}」。只能是 ` +
              `${[...VALID_MARKERS].join(' ')} 里面的一个，后面可以跟小字（像「○ 外训」）`)
          }
          card.marker = g
        }
        return
      }
      if (!table) table = { t: 'table', head: cells.map(clean), rows: [] }
      else table.rows.push(cells.map(clean))
      return
    }

    if (line.trim().startsWith('|')) return  // 分隔行
    if (line.trim() && !/^[#\-`]/.test(line.trim())) {
      pushTable()
      blocks.push({ t: 'p', v: clean(line) })
    }
  })
  flush()
  return cards
}

/* ── cast.md：本篇人物 ──────────────────────────── */

function parseCast(rel) {
  const { lines } = read(rel)
  const people = []
  let cur = null

  const flush = () => { if (cur && cur.name) people.push(cur); cur = null }

  lines.forEach((line) => {
    const h = line.match(/^#\s*[一二三四五六七八九十]+、\s*(.+?)(?:\s*⚠️)?\s*$/)
    if (h && !/其余角色/.test(h[1])) {
      flush()
      // 标题里的括注（如「荆轲（主角）」）不属于名字
      cur = { name: h[1].replace(/（[^）]*）/g, '').trim(), meta: {}, knows: [], infers: [], forbids: [], lines: [] }
      return
    }
    if (/^#\s*[一二三四五六七八九十]+、其余角色/.test(line)) { flush(); return }
    if (!cur) return

    const c = tableRow(line)
    if (c && c.length >= 2 && c[0]) cur.meta[clean(c[0]).replace(/\*\*/g, '')] = clean(c[1])
  })
  flush()

  // 其余角色表：从「其余角色」标题起，遇到任何标题就停
  const others = []
  const oi = lines.findIndex((l) => /^#\s*[一二三四五六七八九十]+、其余角色/.test(l))
  if (oi > -1) {
    for (let i = oi + 1; i < lines.length; i++) {
      if (/^#{1,4}\s/.test(lines[i])) break
      const c = tableRow(lines[i])
      if (c && c.length >= 3 && !/^人物$/.test(c[0])) {
        others.push({ name: clean(c[0]), role: clean(c[1]), source: clean(c[2]), lines: clean(c[3] ?? ''), note: clean(c[4] ?? '') })
      }
    }
  }

  return { people, others }
}

/* ── 主流程 ─────────────────────────────────────── */

function buildPerson(id) {
  const dir = `people/${id}`
  if (!exists(`${dir}/person.md`)) throw new Error(`${dir}/person.md 不存在`)

  const warn = []
  const assets = syncAssets(id)

  const meta = parsePersonMeta(`${dir}/person.md`)
  /* 第三个参数是「这一本叫什么」——没有 `## 底本` 小节时全篇都归它。
     **取的是 meta.sourceBook，不是 meta['出处']。**
     parsePersonMeta 返回的是**输出字段名**（sourceBook / sourceRange / …），
     中文键只活在它内部；写 `meta['出处']` 永远是 undefined。
     代价是荆轲那一页的「原文」分节标题印着「正史 · 未署名的底本」——
     一句内部占位符，摆在读者面前，一路绿灯。 */
  const source = parseSource(`${dir}/source.md`, `${dir}/source.md`, meta.sourceBook || null)
  const storyList = parseStoryList(`${dir}/stories.md`)
  const cast = exists(`${dir}/cast.md`) ? parseCast(`${dir}/cast.md`) : { people: [], others: [] }

  const stories = {}
  for (const s of storyList) {
    const contentRel = `${dir}/stories/${s.id}.md`
    if (!exists(contentRel)) continue

    const content = parseStoryContent(contentRel, source)
    const seedsRel = `${dir}/seeds/${s.id}.md`
    const cardsRel = `${dir}/cards/${s.id}.md`

    const st = {
      ...s,
      ready: true,
      ...content,
      seeds: exists(seedsRel) ? (checkOwnNumber(seedsRel, s.id), parseSeeds(seedsRel)) : [],
      cards: exists(cardsRel) ? (checkOwnNumber(cardsRel, s.id), parseCards(cardsRel)) : [],
    }

    // 图片：内容里只写文件名，这里解析成 URL。缺图只警告，不阻断编译。
    st.img = resolveImg(st.imgFile, assets, warn, `${s.id} 封面`)
    for (const b of st.beats) {
      b.img = resolveImg(b.imgFile, assets, warn, `易水送别第 ${b.n} 段`)
    }
    for (const bg of st.backgrounds) {
      bg.img = resolveImg(bg.imgFile, assets, warn, `${s.id} 背景卡「${bg.name}」`)
    }

    stories[s.id] = st
  }

  /* 这个人的底本清单，按档次和书分组。
     渲染层拿它给「本篇原文」页签分节，也拿它给引用行标书名。
     **顺序必须显式排**：不能靠 Object.values 的次序——
     JS 对象把「101」这种键当整数索引排在后面，而「001」不是，
     两类的相对次序不是文件里的次序，正史会被挤到注后面去。 */
  const books = []
  for (const s of Object.values(source)) {
    let g = books.find((b) => b.book === s.book && b.tier === s.tier)
    if (!g) { g = { book: s.book, tier: s.tier, ids: [] }; books.push(g) }
    g.ids.push(s.id)
  }
  const tierRank = (t) => { const i = TIERS.indexOf(t); return i < 0 ? 99 : i }
  books.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.book.localeCompare(b.book))
  for (const b of books) b.ids.sort()

  return {
    id,
    ...meta,
    portrait: resolveImg(meta.imgFile, assets, warn, `${meta.name} 画像`),
    assetCount: Object.keys(assets).length,
    warnings: warn,
    sourceCount: Object.keys(source).length,
    source,
    books,
    storyList: storyList.map((s) => ({ ...s, ready: !!stories[s.id], img: stories[s.id]?.img || null })),
    cast,
    stories,
  }
}

function listPeople() {
  if (!fs.existsSync(PEOPLE)) throw new Error(`找不到 ${PEOPLE}`)
  return fs.readdirSync(PEOPLE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
}

/* ── 校验 ──────────────────────────────────────── */

/* 前四个标记说的是「这句话在史料上站得住多少」。
   ◇ 是第五个，说的是**别的书**：这条出自底本正文之外的记载——小说、野史。
   它不是"更不可靠的 ◆"，是"另一个世界的说法"，所以给一个不同的字形，
   书名永远跟着一起显示（依据面板、「本篇原文」的分节标题）。
   注（裴松之引的别史）仍用 ◆：那是史料，只是不在正文里，书名标出来就够。 */
const VALID_MARKERS = new Set(['◆', '◇', '○', '△', '—', 'ⓘ'])

/* 第六个标记 `ⓘ`：**回答的是产品本身，不是史料。**
   前五个都在说"这句话在史料上站得住多少"，而「这条回答的依据是什么？」
   「这一篇跨了多少年？」「你是 AI 吗？」这些问题没有史料可站——
   它们是产品说明。原来这些条目各篇自己找地方：02 借 ◆、03 借 ◆、08 借 —、
   01 混用 ○/△，读者看到「你们怎么知道这些的？◆ 出自原文」——
   图例说 ◆ 可逐字核对，而这一句核不了。
   判据是机械的：**这一条的 sys 非空、且没有回答行**（整条就是一个系统说明）。
   `sys` + 回答行的那种（角色被问到未来，答"没有回答"再附一句说明）不算，
   那种仍然是史料问题，该用 `—`。 */
const SYS_ONLY = (seed) => !!seed?.sys?.trim() && !seed?.answer?.length

/**
 * 标记可以带副标注，例如「○ 外证」「○ 训释」——
 * 取首个非空字符来判断，不要卡死整个字符串。
 */
const markerOf = (v) => String(v ?? '').trim().replace(/^[*`\s]+/, '').charAt(0)

/* ── 范围变更账本 ──
   **「范围变了，话要跟着变」这条规矩，机械化的难点是它会变成循环**：
   如果让文件自己声明「我对着哪个范围写的」，那么改范围的人只要顺手改那个声明，
   闸门就闭嘴了——同一只手既改范围、又改声明、又是唯一判定归绿的人。

   所以改成**查事件**：账本记两样东西——
     ① 这一篇上一次是对着哪个范围写的
     ② 当时 seeds/cards 的**内容指纹**
   规则：范围变了、而指纹**没变** → 红（你只改了范围，没重读种子卡）；
        指纹也变了 → 说明真重读了 → 账本更新，放行。
   **没有可以被改绿的自述字段**：唯一能让闸门闭嘴的动作，就是真的去动那个文件。 */
const LEDGER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'range-ledger.json')
function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')) } catch { return {} }
}
const hashOf = (rel) => {
  const full = path.join(ROOT, 'content', rel)
  if (!fs.existsSync(full)) return '(缺)'
  return createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16)
}

/**
 * 引文核对用。
 *
 * 归一化要处理三件事（不处理就会误报）：
 *   1. 嵌套引号：「他说：『好』」和原文里的「他说：「好」」是同一句
 *   2. 省略号截断：「甲……乙」只核首尾两段
 *   3. 标点与空白
 */
function normalizeQuote(v) {
  return String(v)
    .replace(/\*\*|`/g, '')                                   // 语料里引文常夹 ** 和反引号
    .replace(/[『』「」“”"']/g, '')      // 嵌套引号：『』 与 「」 是同一句
    .replace(/[，。；：、！？…—·　\s＝=]/g, '')   // 标点、空白，以及训释记号里的 ＝
}
function quoteFound(quote, haystack) {
  const parts = String(quote).split(/…+|\.\.\.+/).map(normalizeQuote).filter((x) => x.length >= 4)
  if (!parts.length) return true
  const hay = normalizeQuote(haystack)
  return parts.every((x) => hay.includes(x))
}

/**
 * 收集**全部**问题再一次性报告，而不是遇到第一个就抛。
 *
 * 编译期的 ParseError 是"结构坏了，没法继续"——那种必须立刻停。
 * 这里是"结构没问题但内容有问题"——写作者应该一次看到所有要改的地方，
 * 而不是改一处、跑一次、再发现下一处。
 */

function validateContent(people) {
  const errs = []
  const warns = []
  let checks = 0
  const err = (loc, msg) => errs.push(`${loc}\n      ${msg}`)
  const warn = (loc, msg) => warns.push(`${loc}\n      ${msg}`)

  /* 「产品在说自己」或者「跟读者说话」的口吻。入戏的内容里都不许出现。
     踩过两次：一次是给曹操写的引子四段全是「这一篇不回答…」「它把这个人
     拆成很多篇故事…」；一次是场景末段写成
     「你记得的不是这个。……这一段，《武帝纪》里没有。」——用户的原话是
     「写的很破坏氛围感」，因为**读者的主语被从相府门口拽出来上了一课**。

     判据只有三条，都在问"这句话的主语是谁"：
       · 拿书当主语：底本 / 正史 / 史书 / 《某某书》 + 没有·不载·未载·只记
       · 拿读者当主语：你记得 / 你以为 / 你可能不知道 / 大家都知道
       · 拿这份东西当主语：本篇 / 本文 / 这篇故事 / 本产品
     早先的词表里塞了「这一段」「这一节」——那会误伤正常的叙述
     （「这一段路走了三天」被读成"产品在说自己"）；而真正要拦的那句
     「这一段，《武帝纪》里没有」本来就被第一条抓住。所以只留带书名的形状。
     同样**不能拿「你」当判据**——台词里「请你留意」是正当用法。
     测之前先把「」里的台词摘掉：人物说什么都行。

     查的是**入戏内容**：person.md 的「他是谁」「引子」、门口的情境铺陈（含它的
     「行」列）、情节点正文。背景卡、依据映射表、逐行依据的「依据」列**不在管辖内**
     ——那几处的本分就是谈书，「正史里没有这把刀」是「七星刀」那张卡的全部内容。 */
  const SELF_REF = new RegExp([
    '(?:底本|正史|史书|原文|本纪|列传|《[^》]{1,14}》)[^。！？\\n]{0,10}?(?:没有|没写|没记|不载|未载|不记|只说|只记|只写)',
    '书上?(?:没有|没写|没记)',
    '你记得|你以为|你可能不知道|大家都知道',
    '本篇|本文|这篇故事|本产品|这个产品|读者',
  ].join('|'))

  /* 台词摘掉再判——人物嘴里什么都能说。 */
  const stripDialogue = (t) => String(t).replace(/[「『][^」』]*[」』]/g, '')

  const ledger = readLedger()
  const nextLedger = { ...ledger }

  for (const p of people) {
    const who = p.name

    /* 人物页 */
    checks++
    if (!p.intro?.length) err(`${who} · person.md`, '「他是谁」一节是空的')
    checks++
    if (!p.timeline?.length) warn(`${who} · person.md`, '没有「关键时点」表')

    /* 「他是谁」和「引子」里不许出现产品自述的口吻。
       对照荆轲那段：每句话的主语都是荆轲，而且有一句论断
       （「他不是一个刺客。他是去签一份合同的。」）。 */
    for (const [where, texts] of [
      [`${who} · person.md「他是谁」`, p.intro || []],
      [`${who} · person.md「引子」`, p.why || []],
    ]) {
      for (const t of texts) {
        checks++
        const m = SELF_REF.exec(stripDialogue(t))
        if (m) err(where, `出现了「${m[0]}」——这是产品在说自己。引子要写的是那个人`)
      }
    }

    /* 人物页要交代自己的底本范围。
       故事早就有一条「原文」范围；人物页原来什么都没有，于是曹操的引子
       讲了七件底本里没有的事——其中「赤壁烧掉了自己的船」还是魏方单方面
       的说法，正文只有「乃引军还」——而编译器一路绿灯。
       这一条只保证范围**声明了而且编号存在**，保证不了逐句对得上；
       但有了范围，写的人就得先回答"这些事凭什么"。 */
    checks++
    const personProse = (p.intro?.length || 0) + (p.why?.length || 0)
    if (personProse > 0 && !p.sourceRange) {
      err(`${who} · person.md`,
        '没声明「底本」范围——「他是谁」和「引子」里每句话都要能回到 source.md 的编号，' +
        '在标题下的元数据表里加一行「| **底本** | `001–019` |」')
    }
    if (p.sourceRange) {
      const range = []
      const rm = String(p.sourceRange).match(/(\d{3})\s*[–\-—~]\s*(\d{3})/)
      if (rm) { for (let i = Number(rm[1]); i <= Number(rm[2]); i++) range.push(String(i).padStart(3, '0')) }
      else range.push(...(String(p.sourceRange).match(/\d{3}/g) || []))
      checks++
      if (!range.length) err(`${who} · person.md`, `「底本」写成「${p.sourceRange}」了，读不出编号`)
      for (const id of range) {
        checks++
        if (!p.source[id]) err(`${who} · person.md`, `「底本」里的编号 ${id} 在 source.md 里不存在`)
      }
    }

    /* 原文底本的编号连续性，**按底本分别查**。
       号段本来就是分开的（正史 0xx、注 1xx、小说 2xx），跨底本连着数没有意义——
       016 后面本来就该是 101，不是 017。 */
    for (const b of p.books || []) {
      checks++
      const nums = b.ids.map(Number).sort((x, y) => x - y)
      const base = Math.floor(nums[0] / 100) * 100
      const want = nums.map((_, i) => String(base + i + 1).padStart(3, '0'))
      const missing = want.filter((id) => !p.source[id])
      if (missing.length) {
        err(`${who} · source.md`,
          `「${b.book}」的编号不连续，缺 ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`)
      }
    }

    /* 故事一览 vs 实际文件 */
    const listed = new Set(p.storyList.map((s) => s.id))
    checks++
    for (const s of p.storyList) {
      if (!/^\d{2}-[a-z0-9-]+$/i.test(s.id)) err(`${who} · stories.md`, `故事 id「${s.id}」不合规（应为 NN-slug，如 06-yishui）`)
      checks++
      if (!s.name) err(`${who} · stories.md`, `故事「${s.id}」缺名称`)
      checks++
      if (!s.scene && !s.question) warn(`${who} · stories.md`, `故事「${s.id}」缺「情境」这一列`)
      /* **「状态」这一列不能和事实相反。**
         它原来没有任何校验，于是曹操那 10 行里 9 行写着「⬜ 待写」，
         而编译器按文件是否存在算，报「已实现 10」。一列没人管的字段
         迟早变成负债——要么废弃它，要么看着它。这里选看着它。 */
      checks++
      const label = String(s.statusLabel || '')
      const saysReady = /已实现|✅/.test(label)
      const saysPlan = /待写|⬜/.test(label)
      if (s.ready && saysPlan) {
        err(`${who} · stories.md`, `故事「${s.id}」状态写的是「${label}」，可 stories/${s.id}.md 已经存在——改状态，或者删文件`)
      }
      if (!s.ready && saysReady) {
        err(`${who} · stories.md`, `故事「${s.id}」状态写的是「${label}」，可 stories/${s.id}.md 并不存在`)
      }
      checks++
      /* 只对**已实现**的篇目要求原文范围。待写的篇目还没有原文段落，
         对它报这一条只是噪音——曹操那十篇计划一次刷出九条。 */
      if (s.ready && !s.sourceRange) warn(`${who} · stories.md`, `故事「${s.id}」缺原文范围`)
      else if (s.sourceRange) {
        /* 范围里的编号必须真的存在。
           `sourceRange()` 取不到编号就**静默跳过**，而「本篇原文」页签的标题
           印的是原文范围——写成 `001–004、019` 而 019 不存在，页面上只是
           少一段原文，标题照样是完整那串，看不出少了。 */
        const range = parseRange(s.sourceRange)
        /* 范围变更对账：范围变了、种子和卡的内容指纹没变 → 红。 */
        {
          const key = `${p.id}/${s.id}`
          const now = {
            range: String(s.sourceRange || '').trim(),
            seeds: hashOf(`people/${p.id}/seeds/${s.id}.md`),
            cards: hashOf(`people/${p.id}/cards/${s.id}.md`),
          }
          const was = ledger[key]
          checks++
          if (was && was.range !== now.range && was.seeds === now.seeds && was.cards === now.cards) {
            err(`${who} · stories.md`,
              `故事「${s.id}」的原文范围从「${was.range}」变成了「${now.range}」，` +
              '**而 seeds/ 和 cards/ 一个字都没动**。范围一变，那两个文件里所有' +
              '「本篇这几段」「这几段里没有」的说法就全是假话——**而编译器查不出来**。' +
              '重读一遍再改范围')
          } else if (!was || was.range !== now.range || was.seeds !== now.seeds || was.cards !== now.cards) {
            nextLedger[key] = now
          }
        }
        checks++
        if (!range.length) err(`${who} · stories.md`, `故事「${s.id}」的原文范围「${s.sourceRange}」读不出编号`)
        const miss = range.filter((id) => !p.source[id])
        checks++
        if (miss.length) {
          err(`${who} · stories.md`,
            `故事「${s.id}」的原文范围里有 source.md 中不存在的编号 ${miss.join(', ')}——` +
            '页面会把它们静默跳过，只少几段原文，标题却照印')
        }
      }
    }
    // 有文件但没登记在故事一览里
    const dir = path.join(PEOPLE, p.id, 'stories')
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue
        const id = f.replace(/\.md$/, '')
        checks++
        if (!listed.has(id)) err(`${who} · stories.md`, `stories/${f} 存在，但「故事一览」里没有登记`)
      }
    }

    /* 各篇故事 */
    for (const s of p.storyList) {
      if (!s.ready) continue
      const st = p.stories[s.id]
      const at = `${who} · ${s.id}`

      checks++
      if (!st.beats.length) err(at, '没有情节点')

      /* ── 故事一览 ⟷ 故事文件，两边对账 ─────────────
         这一对离得最近，却一直没人查：**文件里那两处声明，从前没有任何代码读。**
         文件第一行的篇名是装饰（页面篇名一律取自 stories.md），
         前表的「| **原文** |」也是装饰（只有「地点」被读）。
         于是把故事一览里 `01-wusebang` 那一行的篇名改成「曹操刺董」，
         编译全绿——而读者看到「曹操刺董」这张卡，点进去是五色棒。
         这正是这次要修的失败模式，只是换了一对字段。 */
      const bareName = (x) => String(x || '').replace(/[★\s]/g, '')
      checks++
      if (st.title && bareName(st.title) !== bareName(st.name)) {
        err(at, `故事一览写的篇名是「${st.name}」，故事文件第一行写的是「${st.title}」。` +
          `页面上的篇名取自故事一览，读者会看到「${st.name}」这张卡、点进去却是「${st.title}」。两边改成一样`)
      }

      const declared = parseRange(s.sourceRange)
      checks++
      if (!declared.length) err(at, '故事一览的「原文」列是空的——这一篇用到了哪些编号，得写出来')
      if (st.declaredRange) {
        const inFile = parseRange(st.declaredRange)
        checks++
        if (inFile.length !== declared.length || inFile.some((x) => !declared.includes(x))) {
          err(at, `故事一览的「原文」列写的是 ${s.sourceRange}，故事文件前表写的是 ${st.declaredRange}——` +
            '两处必须一致。文件那一行是给读者看的，故事一览那一列是给编译器看的，对不上时没人知道该信哪个')
        }
      }

      /* 每一段引的编号，必须落在这一篇声明的范围里。
         原来把故事一览的范围改小（001–003、008、201–209 → 001–003），
         编译照样全绿，而这一篇 6 段里有 4 段引的是范围外的编号。 */
      /* **范围之外的编号，不止情节点有。** 原来只查 `b.sources`，
         于是映射表、背景卡、种子的依据、卡片里引用范围外的编号，全都不管——
         02 的卡片就是这么把演义第四回中牟段引进来、还挂在 `201`–`209` 底下的。
         查的是**每一处提到编号的地方**，一处都不能漏。 */
      const outOfRange = []
      const sweep = (where, text) => {
        if (!text) return
        for (const id of new Set([...String(text).matchAll(/(?<!\d)(\d{3})(?!\d)(?!\s*年)/g)].map((m) => m[1]))) {
          if (p.source[id] && !declared.includes(id)) outOfRange.push(`${where} 引了 ${id}`)
        }
      }
      /* **只查"读者被告知这就是依据"的栏目**，不查映射表和背景卡的散文。
         第一版查了全部，报 179 处——因为荆轲那几篇是链式的，映射表和背景卡里
         引相邻篇的编号是**正当的交叉指路**（06-yishui 的映射表引 `037`，
         意思是"这段情境来自王翦破赵那一段"）。把那种也拦掉，等于逼作者
         少交代一层。
         真正会伤读者的是种子和复习卡的「依据」栏：那一栏的意思是
         "这条回答凭什么"，而栏里的编号在「原文」页签里查不到——
         读者照着去核，核了个空。 */
      for (const sd of st.seeds) {
        /* **依据在 `meta` 里，不在 `ground` 里。** `ground` 是情节点的字段，
           `parseSeeds` 从来不设它——这条第一版写成 `if (sd.ground)`，
           于是对种子**永远不触发**（审核员在沙箱里实测：种子里塞一个范围外的
           `018`，全绿、检查项数一动不动；同一处改在复习卡上立刻报）。
           一条永远不会响的闸门比没有更糟——它让人以为这里有人守。 */
        for (const m of sd.meta || []) {
          if (m.k === '依据') sweep(`种子「${String(sd.q).slice(0, 12)}…」· 依据`, m.v)
        }
        if (sd.ground) sweep(`种子「${String(sd.q).slice(0, 12)}…」· 依据`, sd.ground)
      }

      /* **统计表对账。** 那张「### 标记分布」表原来没有任何校验——
         数字错了没人知道（02 整张表没有、08 把一条算了两遍、
         ⓘ 迁移之后 9 份表变成旧的）。编译器本来就能数，没有理由靠人眼。
         分两行写同一档（`○ 合理推演` / `○ 外证`）没关系，按字形合计。 */
      if (st.seeds.length) {
        checks++
        if (!Object.keys(st.seeds.dist || {}).length) {
          err(at, '种子文件里没有「### 标记分布」表——那是读者判断这一篇"底子有多硬"的地方。' +
            '补一张，数字按实际标记数写（编译器会对账）')
        } else {
          const real = {}
          for (const sd of st.seeds) { const g = markerOf(sd.marker); if (g) real[g] = (real[g] || 0) + 1 }
          for (const g of new Set([...Object.keys(real), ...Object.keys(st.seeds.dist)])) {
            checks++
            const a = real[g] || 0, b = st.seeds.dist[g] || 0
            if (a !== b) {
              err(at, `「标记分布」表和实际对不上：${g} 表里写 ${b}，实际 ${a}。` +
                `（实际分布：${Object.entries(real).map(([k, v]) => k + v).join(' ')}，共 ${st.seeds.length} 条）`)
            }
          }
        }
      }
      for (const c of st.cards) {
        ;(c.meta || []).filter((m) => m.k === '依据').forEach((m) => sweep(`复习卡 ${c.n} · 依据`, m.v))
      }
      /* **提醒，不是拦。** 这里引的编号读者在本篇「原文」页签里查不到，
         指针是断的。但荆轲那几篇是链式结构，「依据」栏引相邻篇的编号是正当的
         交叉指路（06-yishui 的时间线卡要引 05-taizidan 的 037、051 才说得通）——
         硬拦会逼作者少交代一层。所以报出来，由作者判断是补进范围、还是改成篇名。
         （2026-10-14：全库 26 处，几乎全在荆轲的复习卡里。） */
      if (outOfRange.length) {
        checks++
        warn(at, `${outOfRange.length} 处「依据」引了本篇范围（${s.sourceRange}）之外的编号：` +
          outOfRange.slice(0, 3).join('；') +
          '。读者在本篇「原文」页签里查不到它们——是跨篇指路就说清是哪一篇（「见 `05-taizidan`」），' +
          '要摊给读者就补进故事一览那一列')
      }

      for (const b of st.beats) {
        checks++
        const outside = (b.sources || []).filter((id) => !declared.includes(id))
        if (outside.length) {
          err(`${at} · 第 ${b.n} 段`,
            `这一段引了 ${outside.join(' ')}，可本篇声明的原文范围是 ${s.sourceRange}，不含这几个编号。` +
            '三条路：把它补进故事一览那一列（大于一篇真正会摊开给读者的原文）、' +
            '说明是依据挂错了段落、或者——如果只是想指路——写篇名而不是编号。' +
            '**范围外的编号，读者在「依据」面板里只会看到一对空的引号**，因为那一栏的正文' +
            '是按本篇范围取的')
        }
      }

      for (const b of st.beats) {
        checks++
        if (!VALID_MARKERS.has(markerOf(b.marker))) err(`${at} · 第 ${b.n} 段`, `标记「${b.marker}」不是有效值（只能是 ◆ ○ △ —）`)
        checks++
        if (!b.ground) err(`${at} · 第 ${b.n} 段`, '缺「依据」行')
        checks++
        if (b.source && !/^\d{3}$/.test(b.source)) err(`${at} · 第 ${b.n} 段`, `原文编号「${b.source}」不是三位数字`)
        checks++
        if (!b.source && markerOf(b.marker) === '◆') err(`${at} · 第 ${b.n} 段`, '标了 ◆（出自原文）但没有原文编号')
        checks++
        if (!b.source && markerOf(b.marker) === '◇') err(`${at} · 第 ${b.n} 段`, '标了 ◇（出自小说）但没有原文编号')
        /* 引了底本正文之外的另一本书（小说、野史）就必须标 ◇，
           反过来标了 ◇ 就必须真引了这样一本。
           ◆ 在这套东西里的意思是「这是史书写的」——拿它罩住《三国演义》，
           读者会把十四世纪的小说当成陈寿的记载。两个方向都要拦：
           只拦一个方向的话，把小说段落改标成 ◆ 没人管，把正史段落改标成 ◇ 也没人管。

           **野史也是 ◇。** 标记的定义（见 VALID_MARKERS 上面那段）写的就是
           「别的书：小说、野史」，可这里原来只认小说档：真加了野史内容，
           挂 ◆ 被语义否定、挂 ◇ 又被这里判成「不是小说」，两条路都堵死。
           （2026-10-14 子智能体审核查出来的半截接线。）
           注（1xx）仍用 ◆：那是史料，只是不在正文里。 */
        const FOREIGN = new Set(['小说', '野史'])
        const tiers = (b.sources || []).map((id) => p.source[id]?.tier).filter(Boolean)
        const foreignIds = (b.sources || []).filter((id) => FOREIGN.has(p.source[id]?.tier))
        const foreignTiers = [...new Set(foreignIds.map((id) => p.source[id].tier))]
        checks++
        if (foreignIds.length && markerOf(b.marker) !== '◇') {
          err(`${at} · 第 ${b.n} 段`,
            `这一段引了${foreignTiers.join('、')}（${foreignIds.join(' ')}），` +
            `标记必须是 ◇（出自小说或野史，不是史书），现在是「${b.marker}」`)
        }
        checks++
        if (!foreignIds.length && markerOf(b.marker) === '◇') {
          err(`${at} · 第 ${b.n} 段`,
            `标了 ◇（出自小说或野史），可这一段引的 ${tiers.join(' ')} 里没有小说也没有野史`)
        }
        /* **「原文」栏的文字，必须是它标的那个编号的开头。**
           子智能体的变异测试：把情节点 2 的 `| 原文 | \`018\`` 改成 `\`001\``，
           正文一个字没动——编译全绿。后果是「依据」面板里给读者看的是
           001 的原文，而场景讲的是 018 的事。**这是零成本的伪造。**
           查法：把单元格里编号之后的那截归一化，看它在不在 source[id].text 里。
           **不能只比开头**——引用一段中间的某一句是正当写法
           （05-yanzhou 第 2 段讲的就是 019 中段的「刘岱欲击之」）。 */
        if (b.source && b.sourceCell && p.source[b.source]) {
          checks++
          const after = String(b.sourceCell).replace(/^\s*`?\d{3}`?\s*/, '').trim()
          const a = normalizeQuote(after).slice(0, 14)
          const full = normalizeQuote(p.source[b.source].text)
          if (a.length >= 6 && !full.includes(a)) {
            err(`${at} · 第 ${b.n} 段`,
              `「原文」栏写的是 \`${b.source}\`，可这一栏的文字不是 ${b.source} 的开头——` +
              `${b.source} 作「${full.slice(0, 20)}…」，这一栏作「${after.slice(0, 20)}…」。` +
              '编号和正文要指同一段')
          }
        }
        checks++
        if (b.imgFile && !b.imgCaption) warn(`${at} · 第 ${b.n} 段`, '有插图但没写图注')
      }

      for (const bg of st.backgrounds) {
        checks++
        if (!bg.basis) err(`${at} · 背景卡「${bg.name}」`, '缺「依据」行——背景卡必须有原文支撑')
      }

      /* 门口那张「逐行依据」卡。01/02/08 的 fence 不带内联标记，依据全在这张表里；
         表丢了，卡片右列会整片空白——渲染层看不出来的内容缺失，只能在这里拦 */
      checks++
      if (!st.intro?.basis?.length) {
        err(`${at} · 情境铺陈`, '缺「### 逐行依据」表——门口的依据卡靠它渲染')
      } else {
        for (const row of st.intro.basis) {
          const label = `${at} · 逐行依据「${String(row.line).slice(0, 14)}…」`
          checks++
          if (!row.line) err(label, '「行」这一栏是空的')
          checks++
          if (!VALID_MARKERS.has(markerOf(row.marker))) err(label, `标记「${row.marker}」无效`)
          checks++
          if (!row.basis) err(label, '缺依据说明')
        }

        /* **门口和「逐行依据」必须对得上。**
           原来这三件事一件都没查，而它们正是 `new-story.mjs` 声称已经解决了
           的那个「最耗人的串线」。子智能体的变异测试：删掉门口一行、
           把「行」栏换成无关句子、把行尾的 `◆ 017` 改成 `◆ 018`——
           三样都能编译通过。门口是读者进门看到的第一屏，
           它和依据对不上，等于第一屏就在撒谎。

           判据不能要求"行数相等、逐行对应"：荆轲那边的 fence 会**折行**
           （一句话拆成两个物理行，第二行没有标记），而依据表按**逻辑行**
           排，有时还把一行拆成两条（时间戳拆成「年份」和「地点」）。
           所以查三件跟排版无关的事。 */
        const lines = st.intro.lines || []
        const rows = st.intro.basis || []
        const cjk = (t) => String(t || '').replace(/[^\u4e00-\u9fff]/g, '')
        /* 两条文字有没有连续 4 个汉字一样。成稿会压缩、会插字、fence 会折行
           （门口「田光死了。他是自刎的」对依据「田光死了，是自刎的」——
           门口多插了一个「他」），所以不能用全等，也不能把门槛定太高。 */
        const shares = (a, b) => {
          const x = cjk(a), y = cjk(b)
          if (x.length < 4 || y.length < 4) return true
          for (let i = 0; i + 4 <= x.length; i++) if (y.includes(x.slice(i, i + 4))) return true
          return false
        }
        const fenceText = lines.map((l) => l.text).join('')
        const basisText = rows.map((r) => r.basis).join('')
        for (const row of rows) {
          checks++
          if (!shares(row.line, fenceText)) {
            err(`${at} · 情境铺陈 · 逐行依据「${String(row.line).slice(0, 16)}…」`,
              '这一条依据在门口里找不到对应的话——「行」栏要写门口那一行' +
              '（门口会折行，但整句话要在门口里找得到）')
          }
        }
        const fenceIds = [...new Set(lines.flatMap((l) => String(l.marker || '').match(/\b\d{3}\b/g) || []))]
        for (const id of fenceIds) {
          checks++
          if (!basisText.includes(id)) {
            err(`${at} · 情境铺陈`, `门口有一行标着 \`${id}\`，可整张「逐行依据」里没有这个编号`)
          }
        }
        const fenceGlyphs = lines.filter((l) => l.marker).map((l) => markerOf(l.marker)).filter(Boolean)
        const basisGlyphs = new Set(rows.map((r) => markerOf(r.marker)))
        for (const g of new Set(fenceGlyphs)) {
          checks++
          if (!basisGlyphs.has(g)) {
            err(`${at} · 情境铺陈`, `门口用了标记「${g}」，可「逐行依据」里一条这个标记都没有`)
          }
        }
      }

      /* 读者可见字段里不许出现内部行话。
         踩过这些：把「C 级 · 压缩」写进映射表和复习卡的「依据」栏、写进种子的 ⓘ 回答；
         把「已标出 6 段高优先级核对项，另有 15 处待核疑点」写进设置页；
         把「需补编号」留在映射表的依据栏——那是写给自己的待办，读者看到的是
         一句没头没尾的施工告示。读者看不懂「C 级」，也不需要知道我们欠了什么。
         这些话只该留在 source.md 和 审校记录.md 里。

         「待写」「待填」是 `new-story.mjs` 骨架里的占位符。**骨架能编译通过**
         是最坏的一种情况：它会让一篇没写完的故事以「已完成」的样子混进产品。
         这条检查就是拦它——生成完骨架，编译必须是红的。 */
      const JARGON = /C 级|C级|A 级|B 级|待核疑点|高优先级|核对项|优先级|底本标|复核|M2a|M2b|M3\b|需补编号|待补编号|补编号|待补|TODO|待写|待填|待定|XXX|xxx|\$\{/

/* ── 用语：「原文」和「底本」 ──
   「底本」＝这一页依据的那本书（《三国志·魏书·武帝纪》这种）；
   「原文」＝引出来的那段文字（页签、◆ 出自原文、原文块、原文台词）。
   写「这本书没有记载 X」用底本；写「这段文字里没有 X」用原文。
   判据放在这里、由 validateContent 用在**读者可见的字段**上（见那边的循环）。

   「本底本」原来也在拦，靠"前一个字是不是量词"排除误伤——排不干净：
   「这本底本」「那本底本」「哪本底本」「日本底本」全是正常中文。
   一个词读起来别扭，不值得为它养一条会咬人的正则。 */
const BAD_PAIR = /原文底本|底本原文/
/* 「原文」＋最多十四个字＋否定谓语。
   「三段原文」「五篇原文」是"引的那几段"，正当用法，排除。
   （这一条是补的：上一个提交只拦了三个自我修饰，却在 README 里宣称
   "编译器会拦"——实测在内容里写「原文不载」全绿。） */
/* 窗口**不能跨标点**。第一版是 `[^。！？\n]{0,14}`，逗号顿号破折号都能穿过去，
   于是「◆ 出自原文，○ 是推出来的，— 是史书没写」里隔了三个分句的「没写」
   被判成「原文没写」——作者写一句正常的枚举就被拦（04-xingyang 实测踩到）。 */
const MIXED = /(?<![一二三四五六七八九十两\d]\s{0,2}[段篇])原文[^。！？；，、\n]{0,10}(?:[不未没无][载写记解释裁决回答作点明说给答释录]|没有)/
      const visible = [
        /* **渲染出去的字段一个都不能漏。**
           原来漏了「地点」和「在场人物」，而这两个都上屏——
           骨架里的 `| **地点** | （待填） |` 会被渲染成按钮「进 入 （待填）」，
           `| （待填） | | **在场** |` 会在「此刻在场」面板里列出一个叫「（待填）」的人。
           把七处占位符改掉、忘了这两处，`npm run check` 就是绿的，
           而产品里挂着一个「进入（待填）」的按钮。 */
        ['篇名', st.name],
        ['地点', st.place],
        ...(st.present || []).flatMap((x) => [
          ['在场人物 · 人物', x.name],
          ['在场人物 · 身份', x.role],
          ['在场人物 · 状态', x.state],
        ]),
        ...(st.beats || []).flatMap((b) => [
          [`第 ${b.n} 段 · 小标题`, b.title],
          [`第 ${b.n} 段 · 依据`, b.ground],
          ...b.prose.map((p) => [`第 ${b.n} 段 · 正文`, p]),
        ]),
        ...st.groundTable.flatMap((r) => [
          ['依据映射表 · 陈述', r.claim],
          ['依据映射表 · 依据', r.basis],
        ]),
        ...(st.intro?.lines || []).map((l) => ['情境铺陈 · 正文', l.text]),
        ...(st.intro?.basis || []).flatMap((r) => [
          ['逐行依据 · 行', r.line],
          ['逐行依据 · 依据', r.basis],
        ]),
        ...st.backgrounds.flatMap((bg) => [
          [`背景卡「${bg.name}」· 名称`, bg.name],
          ...(bg.body || []).map((t) => [`背景卡「${bg.name}」· 正文`, t]),
          [`背景卡「${bg.name}」· 依据`, bg.basis],
        ]),
        ...st.cards.flatMap((c) => [
          [`复习卡 ${c.n} · 题面`, c.q],
          ...(c.meta || []).map((m) => [`复习卡 ${c.n} · ${m.k}`, m.v]),
          ...(c.blocks || []).flatMap((bl) => [
            [`复习卡 ${c.n} · 答案`, bl.v],
            ...(bl.rows || []).flatMap((row) => row.map((cell) => [`复习卡 ${c.n} · 表格`, cell])),
          ]),
        ]),
        ...st.seeds.flatMap((sd) => {
          const q = `种子「${String(sd.q).slice(0, 12)}…」`
          return [
            ...(sd.answer || []).map((a) => [`${q} · 回答`, a]),
            [`${q} · ⓘ`, sd.sys],
            ...(sd.meta || []).map((m) => [`${q} · ${m.k}`, m.v]),
          ]
        }),
      ]
      for (const [where, text] of visible) {
        if (!text) continue
        checks++
        const m = JARGON.exec(String(text))
        if (m) err(`${at} · ${where}`, `出现了读者不该看到的东西「${m[0]}」——内部行话、模板占位符、写作待办，都只该留在 source.md 和 审校记录.md 里`)

        /* 「原文」和「底本」用混了。
           **查的是读者看得见的字段，不是文件的行。** 第一版写成扫 `content/` 全树，
           于是要一份一份地排除：README 是规则文档（「原文」在它里面是被定义的词）、
           source.md 除了底本表都不上屏、stories.md 只有「故事一览」那一节上屏……
           排到第三份就该明白：要的不是"哪些文件"，是"哪些文字读者会看到"——
           那正是这个 `visible` 列表。挂在这里，一个文件都不用排除。 */
        checks++
        const raw = String(text)
        const bare = raw.replace(/《[^》]*》原文/g, '')
        if (BAD_PAIR.test(bare)) {
          err(`${at} · ${where}`, `「原文底本」这种说法是在用一个词修饰它自己。` +
            '「底本」是这一页依据的那本书，「原文」是引出来的那段文字——写「底本」就够')
        } else if (/本产品|这个产品|本文(?!件)|这篇故事/.test(raw)) {
          /* **产品自述不许出现在读者面前。** 入戏内容那边（person.md 的引子、
             情节点正文、门口）一直有这条闸门（SELF_REF），但卡片、种子、
             背景卡、映射表没有——实测十来处「这个产品最该守住的东西」
             「我能信这个产品吗」。读者要的是内容，不是产品在介绍自己的原则。 */
          err(`${at} · ${where}`,
            `出现了产品自述：「${(raw.match(/本产品|这个产品|本文(?!件)|这篇故事/) || [''])[0]}」。` +
            `现在是「${raw.slice(0, 30)}」——改成直接说那件事本身（「这里」「这一篇」），` +
            '或者把话说成内容')
        } else if (/\[[^\]]+\]\([^)]+\)/.test(raw)) {
          /* **读者可见字段里不许有 markdown 链接。** `RichText` 不认链接，
             方括号和路径会原样印出来；而且指向的多半是仓库里的文件，
             读者点不开、也看不懂。审核查出 15 份种子文件的「依据」栏都有这个形状
             （`见 [\`../../../README.md\`](../../../README.md) 的「…」`）。 */
          err(`${at} · ${where}`,
            `出现了 markdown 链接，读者会看到方括号和路径：` +
            `「${raw.slice(0, 40)}」。改成一句能读懂的话（「产品说明，无原文可核」这种）`)
        } else if (MIXED.test(bare)) {
          err(`${at} · ${where}`,
            `写「原文『不载／没有写』」了。说「**这本书**没有记载 X」要用**底本**——` +
            `现在是「${raw.slice(0, 30)}」。` +
            '「原文」只留给引出来的那段文字（页签、◆ 出自原文、原文块、原文台词）')
        }
      }

      /* 场景正文里同样不许出现"产品在说自己"。
         门口的情境铺陈（fence 本体）也是入戏内容——它就在读者点进来之前那一屏，
         曾经一段「这一段，《武帝纪》里没有」写进这里也能过关。
         它的「逐行依据」表不查这一条：那张表的本分就是谈书和谈体例
         （「本篇的时间跨度」是正当的行标，「底本 4 段中无任何公元纪年」是正当的依据）。 */
      const onstage = [
        ...st.beats.flatMap((b) => b.prose.map((t) => [`第 ${b.n} 段 · 正文`, t])),
        ...(st.intro?.lines || []).map((l) => ['情境铺陈 · 正文', l.text]),
      ]
      for (const [where, t] of onstage) {
        checks++
        const m = SELF_REF.exec(stripDialogue(t))
        if (m) err(`${at} · ${where}`, `出现了「${m[0]}」——这是产品在说自己，这里要写的是那件事`)
      }

      /* 正文里逐字出现底本原句，就必须**整行**用「」包起来。
         漏挂的后果不是"少块装饰"：文言留在正文里，既没有「原文」标示，
         也没有白话回译——读不懂文言的读者直接卡在这一句上。
         上面那条判据问的是"形状像引文、而且是原文"；这一条反过来问
         "是原文、却没有被当成引文"，专治形状判据被绕开的情况
         （后面补个句号、前面加一句「他唱：」都会让形状判据失效）。

         判法用 n-gram 而不是整行比对：`他唱：「风萧萧兮易水寒……」` 整行
         归一化之后不等于底本任何一段，但里面藏着 20 个字连着一样的原文。

         门槛定 12 个字，是量出来的：全库跑 8 个字会误伤 6 处——那些都是
         白话里顺手留下的文言短语（「高渐离击筑荆轲和」9 字、「为人智深而勇沉」
         8 字、「秦并天下立号为皇帝」9 字，还有一处是白话回译里重复了原句）。
         这些短语读者看得懂，算不得"文言卡住人"；连着 12 个字和底本一样，
         就只可能是原文没挂牌子。 */
      const NGRAM = 12
      const gramSet = (s) => {
        const out = new Set()
        for (let i = 0; i + NGRAM <= s.length; i++) out.add(s.slice(i, i + NGRAM))
        return out
      }
      const srcGrams = new Map()
      const quoteRuns = (line, ids) => {
        const n = normalizeQuote(line)
        if (n.length < NGRAM) return null
        for (const id of ids) {
          if (!srcGrams.has(id)) srcGrams.set(id, gramSet(normalizeQuote(p.source[id].text)))
          const g = srcGrams.get(id)
          for (let i = 0; i + NGRAM <= n.length; i++) if (g.has(n.slice(i, i + NGRAM))) return id
        }
        return null
      }
      for (const b of st.beats) {
        if (!b.sources?.length) continue
        /* 引文本身和它的白话回译都跳过：回译里重复原句是正常写法
           （`02-tianguang` 段 8 的「——我听说，长者为行，不使人疑之」）。 */
        const skip = new Set((b.quotes || []).flatMap((q) => [q.at, q.glossAt]).filter((x) => x != null))
        for (const [i, line] of (b.prose || []).entries()) {
          if (skip.has(i)) continue
          checks++
          const id = quoteRuns(line, b.sources)
          if (id) {
            err(`${at} · 第 ${b.n} 段 · 正文`,
              `这一行里有和 \`${id}\` 逐字相同的原文（「${String(line).slice(0, 16)}…」），` +
              '却没挂「原文」牌子。把原文那一句单独占一行、整行用「」包起来（后面可以带句号）——' +
              '它才会渲染成原文块，也才会被要求配白话回译')
          }
        }
      }

      for (const row of st.groundTable) {
        checks++
        if (!VALID_MARKERS.has(markerOf(row.marker))) err(`${at} · 依据映射表`, `「${row.claim.slice(0, 12)}…」的标记「${row.marker}」无效`)
      }

      /* 映射表里引了小说或野史，就得在**同一行**写出书名。
         一个编号看不出档次——`201` 和 `001` 长得一模一样，而 `◇` 的意思
         正是「这一句不是史书」。写在上一行也不行：02-cidong 原来第一行写
         「`201`（《三国演义》第四回）」，接着三行全是「（同上）」，
         读者从中间往下看，就不知道那是谁的第四回。
         （2026-10-14 用户指着这一处问：「你要是引的三国演义就应该标记三国演义」）
         正史和注不拦：正史是默认那一档，注那一档的编号自带书名
         （「裴松之注引孙盛《异同杂语》」）。 */
      for (const row of st.groundTable) {
        /* 编号在这里已经**没有反引号了**——`clean()` 会把 `` `201` `` 洗成 `201`。
           （第一版按反引号找，结果一条都没匹配上，闸门全绿，白装。）
           所以只在**引用长什么样**上收紧，不能在「是不是数字」上收紧：
           曹操的底本里 201–209 正好是小说号段，而 208（赤壁）、209（魏王）
           又是公元年，年份写成「208，建安十三年」「208–209 两年」都会被
           当成引用。原来只挡了「N 年」一种写法，其余照误报。
           判据：编号后面紧跟的是**引文**（「」、：）或者就是一个独立编号，
           不是年份会跟的那种字（年、–、—、~、前后的数字）。
           实话说这条闸门是**提醒**，不是证明——它挡的是「顺手写个编号
           不写书名」，挡不住存心绕过（写成「不是《三国演义》的说法」它也会过）。 */
        const cited = new Set(
          [...String(row.basis).matchAll(/(?<![\d–—~-])(\d{3})(?![\d–—~-])(?!\s*年)/g)]
            .map((m) => m[1])
        )
        for (const id of cited) {
          const src = p.source[id]
          if (!src || (src.tier !== '小说' && src.tier !== '野史')) continue
          checks++
          if (!String(row.basis).includes(src.book)) {
            err(`${at} · 依据映射表`,
              `「${row.claim.slice(0, 14)}…」引了 ${id}，却没写出它出自 ${src.book}。` +
              `这一行的依据现在是「${String(row.basis).slice(0, 26)}」——` +
              '别用「同上」：读者从中间看起，就不知道是谁的书')
          }
        }
      }

      /* 正文里挂「原文」牌子的那一行，必须有编号撑着。
         判别标准本身（整行引号 **且** 与底本逐字相同）由 verify 的端到端检查守：
         它从渲染出来的 <cite> 反查「原文」页签里的底本，两边是独立的。 */
      for (const b of st.beats) {
        for (const q of b.quotes || []) {
          checks++
          if (!b.sources?.length) {
            err(`${at} · 第 ${b.n} 段`, '正文里有「原文」块，但这一段没有任何编号撑着')
          } else if (!b.sources.some((id) => quoteFound(q.text, p.source[id].text))) {
            err(`${at} · 第 ${b.n} 段`, `「原文」块在 ${b.sources.join(' ')} 里找不到`)
          }
          /* 原文台词一律带回译。写成紧跟其后、以「——」开头的一行。
             不写回译，读不懂文言的读者就卡在这一句上——
             而这条规则必须没有例外，否则有的有有的没有，读者不知道什么时候该指望它。 */
          checks++
          if (!q.gloss) {
            err(`${at} · 第 ${b.n} 段`, `原文台词「${String(q.text).slice(0, 14)}…」缺白话回译（紧跟其后写一行「——……」）`)
          }
          /* 引出原文台词的那一句不要用「——」收尾。
             引文是独立的块，破折号会折行、孤零零掉到下一行（长引入句必现）。
             规矩：「：」引出原文台词，「——」引出白话回译
             （回译在块内另起一行，孤立不了）。 */
          const prev = b.prose[q.at - 1]
          checks++
          if (prev && prev.trim().endsWith('——')) {
            err(`${at} · 第 ${b.n} 段`, '引出原文台词的那句拿「——」收尾了——破折号会折行掉到下一行，改用「：」')
          }
        }
      }

      checks++
      if (!st.present?.length) err(at, '缺「在场人物」一节')
      else {
        checks++
        if (!st.present.some((x) => x.here)) err(at, '「在场人物」里一个「在场」都没有')
      }

      /* 可选件：有就查，没有不算错（骨架篇就是没有） */
      checks++
      if (st.seeds.length && !st.cards.length) warn(at, '有对话种子但没有复习卡')
      checks++
      if (st.cards.length && !st.seeds.length) warn(at, '有复习卡但没有对话种子')

      for (const seed of st.seeds) {
        checks++
        if (!seed.q) err(at, '有条对话种子没有「问」')
        /* 每条种子都得有标记。写漏了不会报错的话，界面上的标记徽章就没了，
           而徽章是读者判断「这句话在史料上站得住多少」的唯一入口。
           （2026-10-14：写成「| 标记 | ○ 外证 |」会被静默丢掉，已修；
           这条闸门防的是干脆没写。）
           系统层的种子（`sys`）除外：那些是产品边界说明，不是史料回答。 */
        checks++
        if (!seed.marker && !seed.sys?.trim()) {
          err(at, `对话种子「${seed.q?.slice(0, 16)}…」没有标记——` +
            '读者要靠它判断这句话在史料上站得住多少。写一行「| 标记 | ○ |」（可以跟小字，如「○ 外证」）')
        }
        /* **整条就是系统说明的，标记必须是 `ⓘ`；反过来说，`ⓘ` 只能用在那种形状上。**
           两个方向都拦：只拦一个方向的话，把产品说明标成 ◆ 没人管
           （读者会去核一句没有原文的话），把史料回答标成 ⓘ 也没人管
           （读者会以为那句话不需要依据）。 */
        checks++
        if (SYS_ONLY(seed) && markerOf(seed.marker) !== 'ⓘ') {
          err(at, `对话种子「${seed.q?.slice(0, 16)}…」整条是一段系统说明（没有回答行，只有 ⓘ），` +
            `标记应该是 ⓘ（产品说明），现在是「${seed.marker}」——` +
            '前五个标记都是给史料问题的，拿它们罩一句没有原文可核的话，读者会去核一个核不到的东西')
        }
        checks++
        if (!SYS_ONLY(seed) && markerOf(seed.marker) === 'ⓘ') {
          err(at, `对话种子「${seed.q?.slice(0, 16)}…」标了 ⓘ（产品说明），` +
            '可它不是一个纯系统说明（有回答行，或者没有 ⓘ 块）——' +
            '史料问题要用 ◆ ◇ ○ △ — 里的一个')
        }

        /* **回答行和 sys 至少要有一个。** 两个都没有时，界面会印一行灰字
           「（没有回答）」——而系统层的 ⓘ 写在围栏代码块里时正好落进这个形状，
           于是 10 篇、58 条在界面上先显示「（没有回答）」再贴解释，自相矛盾。
           （渲染那边已经改成"有 sys 就不印兜底"；这条闸门是让它不再发生：
           两个都没有的种子本来就不该存在。） */
        checks++
        if (!seed.answer?.length && !seed.sys?.trim()) {
          err(at, `对话种子「${seed.q?.slice(0, 16)}…」既没有回答行、也没有系统提示——` +
            '界面上会显示成「（没有回答）」。系统层的 ⓘ 写成 `> ⓘ …` 回答行，' +
            '或者写成围栏代码块（那样会解析成 sys）')
        }
        checks++
        // 答案可以是：对话回答 / 系统提示（产品边界题）/ 标了"无"
        const hasAnswer = seed.answer?.length || seed.sys?.trim() || seed.meta?.length
        if (!hasAnswer) {
          err(at, `对话种子「${seed.q?.slice(0, 14)}…」既没有回答、也没有系统提示，也没标"无"`)
        }
      }

      for (const c of st.cards) {
        checks++
        if (!c.q) err(at, '有张复习卡没有题面')
        /* 卡片的标记也走同一条闸门：引了小说／野史，就得在同一张卡上写出书名。
           这段原来是漏的——`cards/02-cidong.md` 手写了两处「◇ 出自小说」，
           而**同一屏的图例**印着「◇ 出自小说《三国演义》，不是史书」，
           读者一边有书名一边没有，正是用户当场问过的那一处。 */
        /* **反过来也要查。** 原来只查「标了 ◇ 却不写书名」，
           不查「引了小说却标 ◆」——于是卡片可以一边引 `201`–`209` 一边挂 ◆，
           读者以为那是史书写的。两个方向是同一个道理，只拦一个等于没拦。 */
        {
          const text = [c.q, c.a, ...(c.meta || []).map((m) => m.v)].filter(Boolean).join(' ')
          const cited = new Set([...text.matchAll(/(?<!\d)(\d{3})(?!\d)(?!\s*年)/g)].map((m) => m[1]))
          const foreign = [...cited].filter((id) => p.source[id] && ['小说', '野史'].includes(p.source[id].tier))
          checks++
          if (foreign.length && markerOf(c.marker) !== '◇') {
            err(at, `复习卡「${c.q?.slice(0, 14)}…」引了${foreign.join(' ')}（小说或野史），` +
              `标记必须是 ◇，现在是「${c.marker}」——读者会以为那是史书写的`)
          }
        }
        if (markerOf(c.marker) === '◇') {
          const text = [c.q, c.a, ...(c.meta || []).map((m) => m.v)].filter(Boolean).join(' ')
          const cited = new Set([...text.matchAll(/(?<!\d)(\d{3})(?!\d)(?!\s*年)/g)].map((m) => m[1]))
          for (const id of cited) {
            const src = p.source[id]
            if (!src || (src.tier !== '小说' && src.tier !== '野史')) continue
            checks++
            if (!text.includes(src.book)) {
              err(at, `复习卡「${c.q?.slice(0, 14)}…」的标记是 ◇，引了 ${id}，` +
                `却没写出它出自 ${src.book}——读者要靠书名判断这条该不该信`)
            }
          }
        }
        /* **每张卡要有「考点」，标记只能有一个。** 两条都是 README 收尾清单里的，
           但一直没人校验——实测荆轲那 8 份复习卡**一张考点行都没有**
           （曹操那批有，因为它们是后来写的），而一卡两个标记的有十几张。
           一条回答只标一个标记，是因为读者的眼睛落在徽章上。 */
        checks++
        if (!(c.meta || []).some((m) => m.k === '考点')) {
          err(at, `复习卡「${c.q?.slice(0, 16)}…」没有「| 考点 |」行——` +
            '那张卡在考什么，得写出来')
        }
        checks++
        {
          const row = (c.meta || []).find((m) => m.k === '标记')
          const glyphs = [...String(row?.v || '')].filter((ch) => VALID_MARKERS.has(ch))
          if (glyphs.length > 1) {
            err(at, `复习卡「${c.q?.slice(0, 16)}…」标了两个标记（${glyphs.join(' ')}）——` +
              '一条回答只标一个：读者的眼睛落在徽章上，而徽章只取第一个字')
          }
        }
        checks++
        if (!c.marker) {
          err(at, `复习卡「${c.q?.slice(0, 16)}…」没有标记——` +
            '读者要靠它判断这条答案在史料上站得住多少。写一行「| 标记 | ○ |」（可以跟小字）')
        }
        checks++
        if (!c.blocks?.length) err(at, `复习卡「${c.q?.slice(0, 14)}…」没有答案`)
      }
    }
  }

  /* ── 绝对年代：凡出现"公元前"的地方必须标「外证」 ──
     底本 91 段里没有任何绝对年代，所有年份都是后世系年。
     规则是"必须标外证并注明需核对"——这条防的是有人直接把年份写进去当事实。 */
  const yearFiles = []
  for (const p of people) {
    for (const s of p.storyList) {
      if (!s.ready) continue
      yearFiles.push([`people/${p.id}/stories/${s.id}.md`, `${p.name} · ${s.id}`])
      yearFiles.push([`people/${p.id}/seeds/${s.id}.md`, `${p.name} · ${s.id} · 种子`])
      yearFiles.push([`people/${p.id}/cards/${s.id}.md`, `${p.name} · ${s.id} · 复习卡`])
    }
  }
  for (const [rel, label] of yearFiles) {
    if (!exists(rel)) continue
    const { lines } = read(rel)
    lines.forEach((line, i) => {
      if (!/公元前\s*\d+\s*年/.test(line)) return
      checks++
      if (!/外证/.test(line)) {
        err(`${label} · ${rel.split('/').slice(-2).join('/')}:${i + 1}`,
            `出现了绝对年代「${line.match(/公元前\s*\d+\s*年/)[0]}」但没有标「外证」——底本无绝对年代，年份必须标注为后世系年`)
      }
    })
  }

  /* ── 引文核对：标了编号的地方，引文必须逐字对得上 ── */
  const citer = (rel, label, source) => {
    if (!exists(rel)) return
    const { lines } = read(rel)
    lines.forEach((line, i) => {
      const cited = ids(line)
      if (!cited.length) return
      const quotes = [...line.matchAll(/「([^」]{6,})」/g)].map((m) => m[1])
      if (!quotes.length) return
      // 这一行是不是「依据 / 原文」行？是的话用更严的规则
      const isBasisRow = /\|\s*(依据|原文)\s*\|/.test(line) || /依据\*\*/.test(line)

      for (const q of quotes) {
        // 「A＝B」是训释记号（后人注解），不是原文引文，跳过
        if (/[＝=]/.test(q)) continue

        // 严格档：依据行 + 只引用一个编号 → 该行所有 ≥6 字的引文都必须命中。
        // **不看虚词。** 上一版只看虚词，结果
        // 「燕国有勇士秦舞阳，年十三，杀人，人不敢忤视」一个虚词都没有，直接被跳过——
        // 而它当时被错标成了 `028`，校验一声没吭。
        const strict = isBasisRow && cited.length === 1 && q.length >= 6
        const looksClassical = /[之其者也乃遂而以为所矣乎焉哉]/.test(q) && q.length >= 8
        if (!strict && !looksClassical) continue
        checks++
        const hit = cited.some((id) => source[id] && quoteFound(q, source[id].text))
        if (!hit) {
          err(`${label} · ${rel.split('/').slice(-2).join('/')}:${i + 1}`,
              `引文「${q.slice(0, 26)}${q.length > 26 ? '…' : ''}」在 ${cited.join(' ')} 的原文里找不到`)
        }
      }
    })
  }

  for (const p of people) {
    for (const s of p.storyList) {
      if (!s.ready) continue
      citer(`people/${p.id}/stories/${s.id}.md`, `${p.name} · ${s.id}`, p.source)
      citer(`people/${p.id}/seeds/${s.id}.md`, `${p.name} · ${s.id} · 种子`, p.source)
      citer(`people/${p.id}/cards/${s.id}.md`, `${p.name} · ${s.id} · 复习卡`, p.source)
    }
  }

  /* ── 引文归属审计 ──
     **每一条引文，都要出自这一行引的编号。**
     编译器本来有一条严格档（依据行只引一个编号时，行内 ≥6 字的「」都要命中它），
     但它只查「依据/原文行」，而且门槛是 6 个字。实测（2026-10-15 独立审计）：
     全库 1145 个单编号行里有 **24 处**引文错位，全部落在它够不着的地方——
     `内部` 栏、说明行、卡片备注，或者引文只有 4–5 个字。曹操和荆轲都中。

     这一条把口径放到最宽：**只要一行引了编号，行内每一处 ≥4 个汉字的「」
     都要在那一行引的编号里找得到**；找不到就报出它真正在哪一段。 */
  for (const p of people) {
    const norm = {}
    for (const [id, seg] of Object.entries(p.source || {})) norm[id] = normalizeQuote(seg.text || '')
    const all = Object.entries(norm)
    for (const st of Object.values(p.stories || {})) {
      for (const rel of [`people/${p.id}/stories/${st.id}.md`, `people/${p.id}/seeds/${st.id}.md`, `people/${p.id}/cards/${st.id}.md`]) {
        const full = path.join(ROOT, 'content', rel)
        if (!fs.existsSync(full)) continue
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        lines.forEach((line, i) => {
          const ids = [...new Set([...line.matchAll(/`(\d{3})`/g)].map((m) => m[1]))]
          if (ids.length !== 1) return                    // 多编号行归并起来对，这里只管单编号行
          const id = ids[0]
          const hay = norm[id] || ''
          for (const m of line.matchAll(/「([^」]{4,})」/g)) {
            const q = normalizeQuote(m[1])
            if (q.length < 4 || hay.includes(q)) continue
            const hit = all.filter(([, v]) => v.includes(q)).map(([k]) => k)
            checks++
            if (hit.length) {
              err(`people/${p.id}/…`, `${rel}:${i + 1}　引文「${m[1].slice(0, 16)}」不在 \`${id}\` 里，` +
                `实出 \`${hit.join('\` `')}\`。**引文要出自这一行引的编号**——` +
                `读者会照着编号去核，核到的是另一段话`)
            }
          }
        })
      }
    }
  }

  /* ── 直译（gloss.md）──
     `content/people/<id>/gloss.md` 是**逐段直译**：跟着原文的字序和句法走，
     不替它顺句子、不补它没说的主语。它和故事里的白话是两回事（那一份是给人读的）。
     这里只做机械核对：**编号必须在 `source.md` 里存在、直译栏不能空、
     编号不能重复**。直译写得「够不够直」是判断，编译器管不了——
     但「指向一段不存在的话」和「留了个空栏」它管得了。 */
  for (const p of people) {
    const g = path.join(ROOT, 'content', `people/${p.id}/gloss.md`)
    if (!fs.existsSync(g)) continue
    const seen = new Set()
    fs.readFileSync(g, 'utf8').split('\n').forEach((l, i) => {
      const m = l.match(/^\|\s*(\d{3})\s*\|([^|]*)\|([^|]*)\|\s*$/)
      if (!m) return
      checks++
      const [, id, src, gloss] = m
      if (!p.source[id]) {
        err(`people/${p.id}/gloss.md`, `第 ${i + 1} 行直译的是 \`${id}\`，而 \`source.md\` 里没有这个编号——` +
          '读者会照这个号去「原文」页签里核，核到的是空的')
      }
      checks++
      if (seen.has(id)) err(`people/${p.id}/gloss.md`, `第 ${i + 1} 行 \`${id}\` 出现了两次`)
      seen.add(id)
      checks++
      if (!gloss.trim()) err(`people/${p.id}/gloss.md`, `第 ${i + 1} 行 \`${id}\` 的直译栏是空的`)
      checks++
      if (!src.trim()) err(`people/${p.id}/gloss.md`, `第 ${i + 1} 行 \`${id}\` 的原文栏是空的`)
    })
  }

  /* ── 拼接引文 ──
     **整行是「」、而那句话不在底本的任何一段里，但按标点切开之后每一截都在
     （可能来自不同的段）——那是把两段话接成了一句。**
     为什么需要这一条：编译器的「原文」块判别标准是「整行引号 **且** 与底本逐字相同」。
     于是**逐字对不上的整行引号会被静默当成白话**——一声不响。
     2026-10-15 `01-wusebang` 的子智能体撞上了它（「迁顿丘令，征拜议郎」是
     `006`+`007` 拼接），自己写脚本才抓出来。

     判据为什么是「每一截都在」而不是「像文言」：试过后者，分不开——
     荆轲的八篇里有 36 行整行引号是**正当的白话回译**（「我叮嘱田先生不要说出去…」），
     文言虚词占比最高的一行反而是白话（0.17）。而「每一截都在底本里」这条
     在全库误报 0 处、且精确抓住已知的那个例子。 */
  {
    const segs = []
    for (const p of people) for (const [id, seg] of Object.entries(p.source || {}).sort((a, b) => Number(a[0]) - Number(b[0]))) segs.push([id, normalizeQuote(seg.text || '')])
    const whereIs = (t) => segs.filter(([, v]) => v.includes(t)).map(([k]) => k)
    for (const p of people) {
      for (const st of Object.values(p.stories || {})) {
        for (const b of st.beats || []) {
          /* `prose` 是**数组**（一行一条），不是字符串——`String()` 一拼，
             `^…$` 就再也匹配不上，闸门会静默失效（实测踩到）。 */
          const lines = Array.isArray(b.prose) ? b.prose : [b.prose || '']
          for (const raw of lines.map((l) => String(l).match(/^「(.+)」\s*。?$/)).filter(Boolean).map((m) => m[1])) {
            checks++
            const whole = normalizeQuote(raw)
            if (whole.length < 8 || whereIs(whole).length) continue
            const parts = String(raw).split(/[，。；：、！？]/).map(normalizeQuote).filter((x) => x.length >= 4)
            if (parts.length < 2) continue
            const hits = parts.map(whereIs)
            if (!hits.every((h) => h.length)) continue
            err(`${p.name} · ${st.id}`, `整行引号的那句话「${raw.slice(0, 20)}…」不在底本任何一段里，` +
              `但**按标点切开之后每一截都在**——` +
              parts.map((x, i) => `「${x.slice(0, 10)}」在 ${hits[i].map((h) => '\`' + h + '\`').join('／')}`).join('，') +
              `。**这是把两段话接成了一句**：要么拆成两条引文，要么照原文连着写`)
          }
        }
      }
    }
  }

  console.log('')
  if (warns.length) {
    console.log(`  ⚠ ${warns.length} 处提醒`)
    for (const w of warns) console.log(`    · ${w}`)
    console.log('')
  }
  if (errs.length) {
    console.log(`  ✗ ${errs.length} 处错误（检查了 ${checks} 项）\n`)
    for (const e of errs) console.log(`    · ${e}`)
    console.log('')
    throw new Error(`内容校验未通过：${errs.length} 处错误`)
  }
  console.log(`  ✓ 内容校验  检查了 ${checks} 项，全部通过`)
  /* 非 --check 时把账本落盘：范围或指纹变了就记下新的。
     `--check` 不写任何文件——它在 CI 和本地都要能安全地跑。 */
  if (!CHECK_ONLY && JSON.stringify(nextLedger) !== JSON.stringify(ledger)) {
    fs.writeFileSync(LEDGER, JSON.stringify(nextLedger, null, 1) + '\n')
    console.log('  · 范围变更账本已更新（scripts/range-ledger.json）')
  }
}

function main() {
  const t0 = Date.now()
  console.log('\n观史 · 内容编译\n')

  const idsList = listPeople()
  if (!idsList.length) throw new Error('content/people/ 下没有任何人物目录')

  const people = []
  for (const id of idsList) {
    const p = buildPerson(id)
    people.push(p)

    const ready = p.storyList.filter((s) => s.ready)
    console.log(`  ✓ ${p.name}（${id}）`)
    console.log(`      原文 ${p.sourceCount} 段 · 故事 ${p.storyList.length} 篇（已实现 ${ready.length}）· 本篇人物 ${p.cast.people.length} 个 · 图片资源 ${p.assetCount} 个`)
    for (const s of ready) {
      const st = p.stories[s.id]
      const imgs = (st.img ? 1 : 0) + st.beats.filter((b) => b.img).length + st.backgrounds.filter((b) => b.img).length
      console.log(`      · ${s.id}  ${st.beats.length} 段 · 背景卡 ${st.backgrounds.length} · 种子 ${st.seeds.length} · 复习卡 ${st.cards.length} · 图 ${imgs}`)
    }
    for (const w of p.warnings) console.log(`      ⚠ ${w}`)
  }

  // 交叉校验：所有被引用的编号必须在原文底本里存在
  //
  // 三位数在这套内容里有两个身份：**底本编号**（001–091）和**公元纪年**（189 年）。
  // 早先的写法是扫整个序列化对象再补一个 (?!\s*年)，两个毛病：
  //   · 只挡得住紧跟着「年」的那一种。「公元 189–190 年」「公元 189、190 年」
  //     「公元 189」全部照报「引用了不存在的原文编号 189」，而且是 throw，
  //     整次编译中断。
  //   · 为了躲开年份把扫描面收窄到几个字段，于是写进**情节点正文、背景卡正文、
  //     情境铺陈（含它的标记位）**的编号没人管——fence 标记位是旧版能抓到的，属回归。
  //
  // 现在反过来做：先把**年份表达式**整段挖成占位符，再在剩下的话里找编号。
  // 扫描面恢复到"读者看得见的所有文字"，年份挡在挖除那一步。
  const YEAR_EXPR = new RegExp(
    [
      '公元\\s*前?\\s*\\d{1,4}(?:\\s*[–—~\\-－、,，/至到]\\s*\\d{1,4})*\\s*年?',
      '(?<![\\d])\\d{1,4}(?:\\s*[–—~\\-－、,，/至到]\\s*\\d{1,4})*\\s*年',
      /* 「前 227」——省掉「公元」的写法。要求「前」前面不是汉字，
         免得把「门前227」这种真数字也挖掉。 */
      '(?<![\\d\\u4e00-\\u9fff])前\\s*\\d{1,4}(?:\\s*[–—~\\-－、,，/至到]\\s*\\d{1,4})*',
    ].join('|'),
    'gm'
  )
  const blankYears = (t) => t.replace(YEAR_EXPR, (m) => m.replace(/\d/g, '·'))

  const cited = (s) => [
    s.sourceRange,
    ...(s.beats || []).flatMap((b) => [
      b.title, b.source, ...(b.sources || []), b.ground, ...(b.prose || []),
    ]),
    ...(s.backgrounds || []).flatMap((b) => [b.name, b.basis, ...(b.body || [])]),
    ...(s.groundTable || []).flatMap((r) => [r.claim, r.basis]),
    ...(s.intro?.lines || []).flatMap((l) => [l.text, l.marker]),
    ...(s.intro?.basis || []).flatMap((r) => [r.line, r.basis]),
    ...(s.present || []).flatMap((x) => [x.name, x.role, x.state]),
    ...(s.seeds || []).flatMap((d) => [...(d.meta || []).map((m) => m.v), d.sys, ...(d.answer || [])]),
    ...(s.cards || []).flatMap((c) => [...(c.meta || []).map((m) => m.v), c.q, c.a]),
  ].filter(Boolean).join('\n')

  for (const p of people) {
    const bad = new Set()
    for (const s of Object.values(p.stories)) {
      /* 反引号是"这确实是个编号"的显式写法（`099`），裸三位数可能是年份——
         两条都收，收完再看它在不在底本里。

         **但必须是"整个数字恰好三位"。** 原来写的是 `/`?(\d{3})`?/g`，
         于是「5000 人」里的前三位被当成编号 500，**整次编译直接中断**：
         写作者只是说了一个正常的大数目，编译器却说他引了一段不存在的原文。
         （2026-10-14 子智能体写种子时踩到，只能绕道写「五千」。）
         前后各加一个「不是数字」的约束就对了——年份那一层由 blankYears 负责挡。 */
      for (const m of blankYears(cited(s)).matchAll(/(?<!\d)`?(\d{3})`?(?!\d)/g)) {
        if (!p.source[m[1]]) bad.add(m[1])
      }
    }
    if (bad.size) throw new Error(
      `${p.name}：引用了不存在的原文编号 ${[...bad].join(', ')}\n` +
      '    如果是**真的引错了编号**，去 source.md 里核一下。\n' +
      '    如果那本来只是个数字——「124 段」「5000 人」这种——它被当成编号了：\n' +
      '      · 编号一律用反引号写（`` `008` ``），编译器就知道那是引用；\n' +
      '      · 或者把数字写成中文（「一百二十四段」），绕开这个判据。\n' +
      '    判据是"裸的三位数可能是编号也可能是数量"。带「年」的会被先挖掉，其余不猜。')
  }
  console.log('\n  ✓ 编号交叉校验  全部有效')

  validateContent(people)

  // 防回归：正文里以破折号结尾的行，不能被当成标记
  const payload = {
    builtAt: new Date().toISOString(),
    counts: {
      people: people.length,
      stories: people.reduce((n, p) => n + p.storyList.length, 0),
      readyStories: people.reduce((n, p) => n + p.storyList.filter((s) => s.ready).length, 0),
    },
    people,
  }

  if (CHECK_ONLY) {
    console.log(`\n✓ 校验通过（未写文件，${Date.now() - t0}ms）\n`)
    return
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'content.json'), JSON.stringify(payload, null, 2), 'utf8')
  const kb = (fs.statSync(path.join(OUT, 'content.json')).size / 1024).toFixed(1)
  console.log(`\n✓ 已写出 web/data/content.json（${kb} KB，${Date.now() - t0}ms）\n`)
}

try {
  main()
} catch (e) {
  console.error(e instanceof ParseError ? e.message : `\n  ✗ ${e.message}\n`)
  process.exit(1)
}
