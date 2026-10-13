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

/** 从文本里抽 3 位编号，如 `054` 或 054 */
const ids = (s) => [...String(s ?? '').matchAll(/`?(\d{3})`?/g)].map((m) => m[1])

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

function parseSource(rel, fileLabel) {
  const { lines } = read(rel)
  const source = {}
  let story = null

  lines.forEach((line) => {
    /* 分组标题。原来是「## 场景 N · 篇名」；人物页用的段落不属于任何一篇故事
       （家世、举孝廉、济南相都在刺董之前），另立一组，所以放一个通用回退：
       任何 ## 标题都当组名，不再只认「场景 N」。 */
    const m = line.match(/^## 场景 (\d+) · (.+)$/)
    if (m) { story = m[1]; return }
    if (/^## 尾声/.test(line)) { story = 'end'; return }
    if (/^## /.test(line)) { story = line.replace(/^##\s*/, '').trim(); return }

    const cells = tableRow(line)
    if (!cells || cells.length < 3) return
    if (!/^\d{3}$/.test(cells[0])) return

    const id = cells[0]
    const rawText = cells[1]
    const priority = cells[2]
    if (!/^[ABC]/.test(priority.replace(/\*\*/g, '').trim())) return

    /* 「注」标记：这一条不是本纪正文（裴松之注引别史、或出自别的传）。
       写法 `注` 或 `注 · 裴松之注引《魏书》`，点后面那截是给读者看的来源。
       和正文并排、同样挂 ◆ 的话，读者会以为曹操闯张让室是陈寿写的——
       而《魏书》是魏方立场、只此一源，更不该看着像两方互证。
       渲染层按 noted 分段另排（`StoryClient` 的「本篇原文」页签）。 */
    const NOTE = /`注(?:\s*·\s*([^`]+))?`/
    const noteM = rawText.match(NOTE)

    source[id] = {
      id,
      story,
      text: rawText.replace(/★/g, '').replace(/`异文`/g, '').replace(NOTE, '').trim(),
      priority: priority.replace(/\*\*/g, '').trim()[0],
      key: /★/.test(rawText),
      variant: /异文/.test(rawText) || /异文/.test(priority),
      compressed: /压缩/.test(priority),
      noted: noteM ? (noteM[1] || '注').trim() : null,
    }
  })

  const n = Object.keys(source).length
  if (n === 0) throw new ParseError(fileLabel, 0, '没有解析出任何原文段落')
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
    if (!/^\d{2}-[a-z0-9-]+$/i.test(id)) continue
    list.push({
      id,
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
  return list
}

/* ── stories/<id>.md：故事内容 ──────────────────── */

function parseStoryContent(rel, source) {
  const { lines } = read(rel)

  const story = {
    intro: { lines: [], basis: [], note: '' },
    beats: [],
    backgrounds: [],
    groundTable: [],
    present: [],
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
        }
        if (k === '依据') beat.ground = clean(cells[1])
      }
      return
    }

    if (section === 'bg') {
      const h = line.match(/^### (.+?)(?:\s+([◆○△—]))?\s*$/)
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
    const g = line.match(/^## ([一二三四五六]、[^（(]+)/)
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

    const markerRow = line.match(/^\|\s*标记\s*\|\s*([◆○△—])\s*\|/)
    if (markerRow) { seed.marker = markerRow[1]; return }

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
        card.meta.push({ k: clean(cells[0]), v: clean(cells[1] ?? '') })
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
  const source = parseSource(`${dir}/source.md`, `${dir}/source.md`)
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
      seeds: exists(seedsRel) ? parseSeeds(seedsRel) : [],
      cards: exists(cardsRel) ? parseCards(cardsRel) : [],
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

  return {
    id,
    ...meta,
    portrait: resolveImg(meta.imgFile, assets, warn, `${meta.name} 画像`),
    assetCount: Object.keys(assets).length,
    warnings: warn,
    sourceCount: Object.keys(source).length,
    source,
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

const VALID_MARKERS = new Set(['◆', '○', '△', '—'])

/**
 * 标记可以带副标注，例如「○ 外证」「○ 训释」——
 * 取首个非空字符来判断，不要卡死整个字符串。
 */
const markerOf = (v) => String(v ?? '').trim().replace(/^[*`\s]+/, '').charAt(0)

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

    /* 原文底本 */
    checks++
    const srcIds = Object.keys(p.source)
    const expected = Array.from({ length: srcIds.length }, (_, i) => String(i + 1).padStart(3, '0'))
    const missingSrc = expected.filter((id) => !p.source[id])
    if (missingSrc.length) err(`${who} · source.md`, `编号不连续，缺 ${missingSrc.slice(0, 8).join(', ')}${missingSrc.length > 8 ? ' …' : ''}`)

    /* 故事一览 vs 实际文件 */
    const listed = new Set(p.storyList.map((s) => s.id))
    checks++
    for (const s of p.storyList) {
      if (!/^\d{2}-[a-z0-9-]+$/i.test(s.id)) err(`${who} · stories.md`, `故事 id「${s.id}」不合规（应为 NN-slug，如 06-yishui）`)
      checks++
      if (!s.name) err(`${who} · stories.md`, `故事「${s.id}」缺名称`)
      checks++
      if (!s.scene && !s.question) warn(`${who} · stories.md`, `故事「${s.id}」缺「情境」这一列`)
      checks++
      /* 只对**已实现**的篇目要求原文范围。待写的篇目还没有原文段落，
         对它报这一条只是噪音——曹操那十篇计划一次刷出九条。 */
      if (s.ready && !s.sourceRange) warn(`${who} · stories.md`, `故事「${s.id}」缺原文范围`)
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
      }

      /* 读者可见字段里不许出现内部行话。
         踩过这些：把「C 级 · 压缩」写进映射表和复习卡的「依据」栏、写进种子的 ⓘ 回答；
         把「已标出 6 段高优先级核对项，另有 15 处待核疑点」写进设置页；
         把「需补编号」留在映射表的依据栏——那是写给自己的待办，读者看到的是
         一句没头没尾的施工告示。读者看不懂「C 级」，也不需要知道我们欠了什么。
         这些话只该留在 source.md 和 审校记录.md 里。 */
      const JARGON = /C 级|C级|A 级|B 级|待核疑点|高优先级|核对项|优先级|底本标|复核|M2a|M2b|M3\b|需补编号|待补编号|补编号|待补|TODO/
      const visible = [
        ...st.beats.flatMap((b) => [
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
        if (m) err(`${at} · ${where}`, `出现了内部行话「${m[0]}」——读者看不懂，这类话只该留在 source.md 和 审校记录.md 里`)
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
         两条都收，收完再看它在不在底本里。 */
      for (const m of blankYears(cited(s)).matchAll(/`?(\d{3})`?/g)) {
        if (!p.source[m[1]]) bad.add(m[1])
      }
    }
    if (bad.size) throw new Error(`${p.name}：引用了不存在的原文编号 ${[...bad].join(', ')}`)
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
