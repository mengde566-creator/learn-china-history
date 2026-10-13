#!/usr/bin/env node
/**
 * 在已核对的底本里找句子。
 *
 * **为什么需要它。** 加一篇故事原来最慢也最险的一步是「写原文」——
 * 凭记忆默写，然后另找人核。现在参考文本躺在 `.refs/` 里，
 * 繁转简、跨底本定位都已经做好了，找句子从"回忆 + 核对"变成"检索 + 抄"。
 *
 * 用法：
 *   node scripts/ref-grep.mjs <要搜的词>              # 全库搜
 *   node scripts/ref-grep.mjs <词> --book 三國志       # 限定底本
 *   node scripts/ref-grep.mjs <词> --n 3              # 前后各显示几句
 *
 * 只显示，不改任何文件。抄进 source.md 之后 `npm run check-sources` 会验。
 *
 * ⚠️ 切句要在**带标点**的文本上做。归一化会把句号一起去掉，
 *    在归一化之后切句等于整篇一句话——第一版就是这么写的，
 *    查一个词把整卷《吴书》都吐了出来。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const REFS = path.join(ROOT, '.refs')

const tw2cn = require('opencc-js').Converter({ from: 'tw', to: 'cn' })
const only = (t) => String(t).replace(/[^\u4e00-\u9fff]/g, '')
const norm = (t) => only(tw2cn(t))

const argv = process.argv.slice(2)
const q = argv.find((a) => !a.startsWith('--'))
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1] }
if (!q) {
  console.log('\n用法：node scripts/ref-grep.mjs <要搜的词> [--book 三國志] [--n 2]\n')
  process.exit(1)
}
const book = opt('book', null)
const span = Number(opt('n', 2))

const BOOKS = [
  { file: 'sgz.txt', name: '《三國志》' },
  { file: 'cike.html', name: '《史記·刺客列傳》' },
  { file: 'sgyy.txt', name: '《三國演義》' },
]

/* 先在**带标点**的文本上切句，再逐句归一化。
   这样句子边界是对的，匹配又不受繁简和标点影响。 */
function sentencesOf(raw, isHtml) {
  const text = isHtml
    ? [...raw.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ')).join('')
    : raw
  return text
    .split(/(?<=[。！？])/)
    .map((s) => s.replace(/\s+/g, '').trim())
    .filter(Boolean)
    .map((s) => ({ raw: tw2cn(s), key: norm(s) }))
}

const needle = norm(q)
let total = 0
console.log('')
for (const b of BOOKS) {
  const p = path.join(REFS, b.file)
  if (!fs.existsSync(p)) continue
  if (book && !b.name.includes(book) && !b.file.includes(book)) continue
  const sents = sentencesOf(fs.readFileSync(p, 'utf8'), b.file.endsWith('.html'))
  const hitAt = []
  sents.forEach((s, i) => { if (s.key.includes(needle)) hitAt.push(i) })
  if (!hitAt.length) continue
  console.log(`  ${b.name}   ${hitAt.length} 处\n`)
  for (const i of hitAt.slice(0, 10)) {
    const from = Math.max(0, i - span)
    const to = Math.min(sents.length, i + span + 1)
    const body = sents.slice(from, to).map((s) => (s === sents[i] ? `【${s.raw}】` : s.raw)).join('')
    console.log('    ' + (from > 0 ? '…' : '') + body + (to < sents.length ? '…' : ''))
    console.log('')
  }
  total += hitAt.length
}
console.log(total ? `  共 ${total} 处。抄进 source.md 之后跑 npm run check-sources 验。\n` : '  没找到。\n')
