#!/usr/bin/env node
/**
 * 给故事改编号（含文件、种子、复习卡、以及所有引用）。
 *
 * **为什么需要它。** 故事 id 出现在文件名、故事一览、种子、复习卡、
 * 交叉引用和文档里。手工改一篇要动五六处，改十篇就是几十处——
 * 而漏一处不会报错，只会让一篇故事静静地变成孤儿。
 * 子智能体做架构评估时把「没有重编号工具」列为会先崩的那一处：
 * 底本中间插一段要手改 10–30 处引用。
 *
 * 用法：
 *   node scripts/renumber.mjs caocao 03-chenliu=04-chenliu 04-xingyang=03-xingyang
 *   node scripts/renumber.mjs caocao --dry 01-a=02-b      # 只看要改什么
 *
 * 它做四件事：
 *   1. 两两交换也能处理（先全部改成临时名，再落到目标名）
 *   2. 重命名 stories/ seeds/ cards/ 三个目录下的文件
 *   3. 改故事一览里那一行（行首的 `id`）以及正文里的 id 字样
 *   4. 改所有内容文件、以及 README 里出现的旧 id
 *
 * 改完必须自己跑 `npm run check`——工具不替编译器背书。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const [personId, ...pairs] = argv.filter((a) => !a.startsWith('--'))
if (!personId || !pairs.length) {
  console.log('\n用法：node scripts/renumber.mjs <人物id> 旧id=新id [旧id=新id …] [--dry]\n')
  process.exit(1)
}

const map = new Map()
for (const p of pairs) {
  const [from, to] = p.split('=')
  if (!from || !to) throw new Error(`看不懂这一对：${p}`)
  if (!/^\d{2}-[a-z0-9-]+$/i.test(to)) throw new Error(`新 id「${to}」不合规（应为 NN-slug）`)
  map.set(from, to)
}

const dir = path.join(ROOT, 'content', 'people', personId)
if (!fs.existsSync(dir)) throw new Error(`找不到 ${dir}`)

/* 先检查：旧 id 必须存在，新 id 不能撞已有文件（除非它也在交换名单里） */
const moving = new Set(map.keys())
const targets = new Set(map.values())
for (const from of moving) {
  const f = path.join(dir, 'stories', `${from}.md`)
  if (!fs.existsSync(f)) throw new Error(`找不到 ${path.relative(ROOT, f)}`)
}
for (const to of targets) {
  const f = path.join(dir, 'stories', `${to}.md`)
  if (fs.existsSync(f) && !moving.has(to)) throw new Error(`${path.relative(ROOT, f)} 已存在，别覆盖`)
}

/* 两两交换安全：先落到 .renumber-tmp，再落目标名 */
const tmp = []
for (const [from, to] of map) {
  for (const sub of ['stories', 'seeds', 'cards']) {
    const a = path.join(dir, sub, `${from}.md`)
    if (!fs.existsSync(a)) continue
    const t = path.join(dir, sub, `${from}.renumber-tmp`)
    tmp.push([a, t, path.join(dir, sub, `${to}.md`)])
  }
}

/* 要改字样的文件：内容目录全部 + README + 脚本里的示例。
   **必须在改名之后重新走一遍**——文件名本身就是 id，
   先前的写法在改名之前就把路径收好了，于是收进一张过期的单子：
   `cards/01-cidong.md` 已经叫 `02-cidong.md` 了，再去读旧名就 ENOENT。
   2026-10-14 第一次真跑这个工具时就是这么崩的：文件全改完了，字样一处没改。 */
const collectTextFiles = () => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(md|mjs|js|jsx)$/.test(e.name)) out.push(p)
    }
  }
  walk(path.join(ROOT, 'content'))
  return [...new Set(out)]
}
const textFiles = collectTextFiles()

console.log(`\n  改编号：${personId}`)
for (const [from, to] of map) console.log(`    ${from}  →  ${to}`)

console.log(`\n  文件：`)
for (const [a, , b] of tmp) console.log(`    ${path.relative(ROOT, a)}  →  ${path.relative(ROOT, b)}`)

console.log(`\n  字样：`)
const hits = []
for (const f of new Set(textFiles)) {
  const t = fs.readFileSync(f, 'utf8')
  let n = 0
  for (const from of moving) n += (t.match(new RegExp(from, 'g')) || []).length
  if (n) hits.push([f, n])
}
for (const [f, n] of hits) console.log(`    ${String(n).padStart(2)} 处  ${path.relative(ROOT, f)}`)

if (dry) {
  console.log('\n  （--dry：什么都没改）\n')
  process.exit(0)
}

/* 落盘：先临时名，再目标名 */
for (const [a, t] of tmp) fs.renameSync(a, t)
for (const [, t, b] of tmp) fs.renameSync(t, b)

/* 改字样。**先全部换成占位符再落**，否则交换（01→02、02→01）会互相覆盖 */
const PH = (i) => `\u0000RN${i}\u0000`
const order = [...map.keys()]
let touched = 0
for (const f of collectTextFiles()) {
  let t = fs.readFileSync(f, 'utf8')
  let changed = false
  order.forEach((from, i) => {
    if (t.includes(from)) { t = t.split(from).join(PH(i)); changed = true }
  })
  if (!changed) continue
  order.forEach((from, i) => { t = t.split(PH(i)).join(map.get(from)) })
  fs.writeFileSync(f, t)
  touched++
}

console.log(`\n  ✓ 改了 ${tmp.length} 个文件名、${touched} 个文件里的字样。`)

/* 改完编号，故事一览里的**行序**还是旧的——编号换了、顺序没换，
   表就会变成「02 在 01 前面」。这是这个工具最容易留下的坑：
   文件、字样全对，只有读者看到的顺序不对，编译器也看不出来。
   这里只提醒，不替人做决定（行序要按时间排，那是内容判断）。 */
const listPath = path.join(dir, 'stories.md')
if (fs.existsSync(listPath)) {
  const rows = fs.readFileSync(listPath, 'utf8').split('\n')
    .map((l) => l.match(/^\|\s*`(\d{2}-[a-z0-9-]+)`\s*\|/))
    .filter(Boolean).map((m) => m[1])
  const bad = rows.findIndex((id, i) => i && id < rows[i - 1])
  if (bad > 0) {
    console.log(`  ⚠ stories.md 里的行序和编号对不上了：${rows[bad - 1]} 后面跟着 ${rows[bad]}`)
    console.log('    行序要按时间排——把那一行挪到该在的位置，别让读者按错的顺序读。\n')
  }
}

console.log('  **现在跑 npm run check**——工具不替编译器背书。\n')
