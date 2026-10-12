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
    const m = line.match(/^## 场景 (\d) · (.+)$/)
    if (m) { story = m[1]; return }
    if (/^## 尾声/.test(line)) { story = 'end'; return }

    const cells = tableRow(line)
    if (!cells || cells.length < 3) return
    if (!/^\d{3}$/.test(cells[0])) return

    const id = cells[0]
    const rawText = cells[1]
    const priority = cells[2]
    if (!/^[ABC]/.test(priority.replace(/\*\*/g, '').trim())) return

    source[id] = {
      id,
      story,
      text: rawText.replace(/★/g, '').replace(/`异文`/g, '').trim(),
      priority: priority.replace(/\*\*/g, '').trim()[0],
      key: /★/.test(rawText),
      variant: /异文/.test(rawText) || /异文/.test(priority),
      compressed: /压缩/.test(priority),
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
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s/.test(l)) break
    const c = tableRow(l)
    if (!c || c.length < 5) continue
    const id = clean(c[0])
    // id 约定为「两位序号-短名」（如 06-yishui），也就是故事文件名。
    // 用严格正则，表头行（id | 故事 | …）就不会被当成一条故事。
    if (!/^\d{2}-[a-z0-9-]+$/i.test(id)) continue
    list.push({
      id,
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

  const flushBeat = () => {
    if (!beat) return
    delete beat.tableSeen
    if (!beat.prose.length) throw new ParseError(rel, 0, `第 ${beat.n} 段没有正文`)
    if (!beat.marker) throw new ParseError(rel, 0, `第 ${beat.n} 段缺少「标记」行`)
    story.beats.push(beat)
    beat = null
  }
  const flushBg = () => { if (bg) { story.backgrounds.push(bg); bg = null } }

  lines.forEach((line) => {
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
    if (/^## 一、/.test(line)) { section = 'intro'; return }
    if (/^## 二、/.test(line)) { section = 'beats'; return }
    if (/^## 三、/.test(line)) { section = 'skip'; flushBeat(); return }
    if (/^## 四、/.test(line)) { section = 'bg'; flushBg(); return }
    if (/^## 五、/.test(line)) { section = 'ground'; flushBg(); return }
    if (/^## 六、/.test(line)) { section = 'present'; flushBg(); return }
    if (/^## 七、/.test(line)) { section = 'skip'; flushBg(); return }

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
      if (h) {
        flushBeat()
        beat = { n: Number(h[1]), title: h[2].trim(), prose: [], marker: null, source: null, sourceText: null, ground: null, tableSeen: false }
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
      if (cells && cells.length >= 3 && cells[0] !== '场景中的陈述') {
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

  for (const p of people) {
    const who = p.name

    /* 人物页 */
    checks++
    if (!p.intro?.length) err(`${who} · person.md`, '「他是谁」一节是空的')
    checks++
    if (!p.timeline?.length) warn(`${who} · person.md`, '没有「关键时点」表')

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
      if (!s.sourceRange) warn(`${who} · stories.md`, `故事「${s.id}」缺原文范围`)
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

      for (const row of st.groundTable) {
        checks++
        if (!VALID_MARKERS.has(markerOf(row.marker))) err(`${at} · 依据映射表`, `「${row.claim.slice(0, 12)}…」的标记「${row.marker}」无效`)
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
  for (const p of people) {
    const bad = new Set()
    for (const s of Object.values(p.stories)) {
      for (const m of JSON.stringify(s).matchAll(/"(\d{3})"/g)) {
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
