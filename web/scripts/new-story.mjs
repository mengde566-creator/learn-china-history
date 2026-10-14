#!/usr/bin/env node
/**
 * 从「故事一览」那一行 + 底本范围，生成一篇故事文件的骨架。
 *
 * **它解决的问题。** 加一篇故事原来最耗人的不是写白话，是**串线**：
 * 门口 fence 的每一行要在「逐行依据」里有一行对应；
 * 每段情节点要挂对原文编号和依据编号；
 * 「依据映射表」要把本篇所有说法再列一遍；
 * 这几个地方少一处，编译器就红，而红的地方常常不是写错的地方。
 *
 * 骨架把这些**结构性**的东西一次生成好：原文正文、编号、表格、
 * 三个地方之间的对应关系。写的人只需要填白话和背景卡，
 * 不用再记「这一行该配哪个编号」。
 *
 * 用法：
 *   node scripts/new-story.mjs caocao 04-xingyang
 *   node scripts/new-story.mjs caocao 04-xingyang --force   # 覆盖已存在的
 *
 * 生成之后：填白话 → npm run check → npm run check-sources
 */

import { citeOf } from '../lib/cite.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRange } from '../lib/range.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PEOPLE = path.join(ROOT, 'content', 'people')

const [personId, storyId] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const force = process.argv.includes('--force')
if (!personId || !storyId) {
  console.log('\n用法：node scripts/new-story.mjs <人物id> <故事id>  例：caocao 04-xingyang\n')
  process.exit(1)
}

const dir = path.join(PEOPLE, personId)
const out = path.join(dir, 'stories', `${storyId}.md`)
if (fs.existsSync(out) && !force) {
  console.log(`\n  ${path.relative(ROOT, out)} 已存在。要覆盖加 --force。\n`)
  process.exit(1)
}

/* ── 故事一览那一行 ─────────────────────────────── */
const listText = fs.readFileSync(path.join(dir, 'stories.md'), 'utf8')
const row = listText.split('\n').find((l) => l.includes(`\`${storyId}\``) && l.startsWith('|'))
if (!row) throw new Error(`stories.md 的故事一览里找不到 ${storyId}`)
const cells = row.split('|').slice(1, -1).map((c) => c.trim())
const [, name, scene, turn, time, range] = cells
if (!/^\d/.test(range || '')) {
  throw new Error(`故事一览里 ${storyId} 的「原文」一列是空的。底本先定下来，再生成骨架。`)
}

/* ── 底本 ───────────────────────────────────────── */
const srcText = fs.readFileSync(path.join(dir, 'source.md'), 'utf8')
const entries = {}
let book = null
srcText.split('\n').forEach((line) => {
  const h = line.match(/^##\s*底本[^·]*·\s*([^·]+?)\s*·\s*(.+?)\s*$/)
  if (h) { book = { tier: h[1].trim(), book: h[2].trim() }; return }
  const c = line.split('|').slice(1, -1).map((x) => x.trim())
  if (c.length < 3 || !/^\d{3}$/.test(c[0])) return
  const pri = (x) => String(x || '').replace(/\*\*|`/g, '').trim()
  let p = c[2], rowNote = null
  if (!/^[ABC]/.test(pri(p))) { rowNote = c[2]; p = c[3] ?? '' }
  if (!/^[ABC]/.test(pri(p))) return
  entries[c[0]] = {
    id: c[0],
    tier: book?.tier || '正史',
    book: book?.book || '',
    /* 出处怎么拼，规则在 `lib/cite.mjs`——**和 build-content.mjs 共用一份**。
       这里原来自己算「rowNote || book」，于是小说档生成的是「第四回」，
       而闸门要求写出书名：生成出来的骨架第一次 npm run check 就红，
       报错还指向刚生成的那一行。加一篇故事的标准动作第一步就卡死。 */
    origin: citeOf({ tier: book?.tier, book: book?.book, note: rowNote }),
    text: c[1].replace(/★/g, '').replace(/`[^`]*`/g, '').trim(),
  }
})

const ids = parseRange(range)
const missing = ids.filter((id) => !entries[id])
if (missing.length) throw new Error(`底本范围里的 ${missing.join(' ')} 在 source.md 里不存在`)

const mark = (e) => (e.tier === '小说' ? '◇' : '◆')
const label = (e) => (e.tier === '正史' ? '' : `（${e.origin}）`)
const head = (e) => e.text.slice(0, 14) + (e.text.length > 14 ? '…' : '')

/* ── 生成 ───────────────────────────────────────── */
const L = []
L.push(`# ${storyId} · ${name.replace(/\*\*/g, '')}`)
L.push('')
L.push('| | |')
L.push('|---|---|')
L.push(`| **地点** | （待填） |`)
L.push(`| **原文** | ${range} |`)
L.push('')
L.push('---')
L.push('')
L.push('## 一、情境铺陈')
L.push('')
L.push('> 进入场景前显示。目标是 30 秒内建立代入感，然后把人交出去。')
L.push('> **每一行都要有一段原文撑着**，下面「逐行依据」逐条对上。')
L.push('')
L.push('```')
for (const id of ids) {
  const e = entries[id]
  L.push(`${'（白话待写）'.padEnd(40, ' ')}← ${mark(e)} ${id}`)
}
L.push('```')
L.push('')
L.push('### 逐行依据')
L.push('')
L.push('| 行 | 标记 | 依据 |')
L.push('|---|---|---|')
for (const id of ids) {
  const e = entries[id]
  L.push(`| ${head(e)} | ${mark(e)}${e.tier === '正史' ? '' : ' **' + e.origin + '**'} | \`${id}\`「${head(e)}」 |`)
}
L.push('')
L.push('---')
L.push('')
L.push('## 二、情节点')
L.push('')
L.push('> **一个情节点必须是一个发生在那一刻的时刻。** 上面每一段底本能撑起一段；')
L.push('> 撑不起一段的，合进相邻那段。写完把用不到的删掉。')
L.push('')
for (const id of ids) {
  const e = entries[id]
  L.push(`### 情节点 ${ids.indexOf(id) + 1} · （小标题待写）`)
  L.push('')
  L.push('> （白话待写）')
  L.push('')
  L.push(`| 标记 | ${mark(e)} |`)
  L.push(`| 原文 | \`${id}\` ${e.text} |`)
  L.push(`| 依据 | \`${id}\` |`)
  L.push('')
  L.push('---')
  L.push('')
}
L.push('## 四、背景卡')
L.push('')
L.push('> 场景里出现、但读者可能不知道是什么的词，一张卡一个。**背景卡必须有原文支撑。**')
L.push('')
L.push('### （待填） ○')
L.push('')
L.push('（待填）')
L.push('')
L.push(`> **依据**：\`${ids[0]}\`。`)
L.push('')
L.push('---')
L.push('')
L.push('## 五、依据映射表')
L.push('')
L.push('> 这张表把**本篇涉及的说法**逐条摊开，不只是场景里写出来的那几句。')
L.push('> 「—」那几行是明确不回答的。审校时按这张表逐条过。')
L.push('')
L.push('| 本篇的说法 | 标记 | 依据 |')
L.push('|---|---|---|')
for (const id of ids) {
  const e = entries[id]
  L.push(`| ${e.text.replace(/\|/g, '｜')} | ${mark(e)} | \`${id}\`${label(e)} |`)
}
L.push(`| （本篇明确不回答的） | — | （待填） |`)
L.push('')
L.push('---')
L.push('')
L.push('## 六、在场人物')
L.push('')
L.push('| 人物 | 身份 | 状态 |')
L.push('|---|---|---|')
L.push('| （待填） | | **在场** |')
L.push('')
L.push('---')
L.push('')
L.push('## 七、设计说明')
L.push('')
L.push('> **这一节编译器跳过，不渲染。** 放"为什么这么写"。')
L.push('')
L.push(`**这一篇的问题是什么。** ${turn || '（待填）'}`)
L.push('')
L.push(`**入口的情境。** ${scene || '（待填）'}`)
L.push('')

fs.writeFileSync(out, L.join('\n'))

const rel = path.relative(ROOT, out)
console.log(`
  已生成 ${rel}

  底本 ${ids.length} 段：
${ids.map((id) => `    ${id}  ${entries[id].tier}  ${entries[id].text.slice(0, 30)}…`).join('\n')}

  ⚠️ 情节点是**按编号顺序**生成的，而编号顺序不一定等于故事顺序。
     底本编号按「正史 → 注 → 小说」分号段，同一篇里注的 102 可能发生在
     正史的 006 之前。曹操那 10 篇实测踩过一次（01-wusebang）。
     **写完先通读一遍时间线，顺序不对就整块搬。** 原文和依据两栏不要改，
     只搬块，理由写进设计说明。

  接下来：
    1. 填白话（门口、情节点）、删掉撑不起一段的、按时间线调整段落顺序
    2. 背景卡：场景里读者可能不认识的词，一张卡一个
    3. 映射表：补「—」那几行——本篇明确不回答什么
    4. 在场人物：这时刻谁在、谁不在
    5. npm run check            ← 结构、标记、行话、引文
    6. npm run check-sources    ← 原文是不是逐字对得上
`)
