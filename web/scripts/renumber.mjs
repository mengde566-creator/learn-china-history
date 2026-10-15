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
 *   node scripts/renumber.mjs caocao 07-aaa=08-bbb 08-bbb=07-aaa
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
import { requireCleanTree } from './lib/guard.mjs'

/* **批量脚本的安全闸门。** 2026-10-15：这个脚本的同类（一个全库重编号脚本）
   在有未提交工作时跑了两遍，改坏 31 个文件，唯一的退路是 `git checkout --`——
   而它把一篇刚做完、已验证的正文一起带走了。
   所以：工作区不干净就拒绝跑。`--force` 可以越过，但要知道代价。 */
/* `--dry` 不写文件，所以不用过闸门——空跑正是脏工作区里该做的事。 */
if (!process.argv.includes('--dry')) requireCleanTree('renumber（会改文件名和全库引用）')

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
  /* 同一个旧 id 写两遍，`Map.set` 会静默只留最后一个——
     用户以为自己说了两件事，实际只做了一件，而命令返回 0。 */
  if (map.has(from) && map.get(from) !== to) {
    throw new Error(`旧 id「${from}」出现了两次（→${map.get(from)}、→${to}）。一次只改一个去处`)
  }
  map.set(from, to)
}

/* 两个旧 id 改到同一个新 id：落盘时第二个会**覆盖**第一个，一篇故事无声消失。
   实测过：`03-chenliu=99-a 04-xingyang=99-a` → 99-a 里只剩荥阳之败，陈留起兵没了，
   而命令输出「✓ 改了 2 个文件名」、退出码 0。
   注意这和「两个 04」不一样——那个只是顺序歧义，这个是丢文件。 */
if (new Set(map.values()).size !== map.size) {
  const seen = new Map()
  for (const [from, to] of map) {
    if (seen.has(to)) throw new Error(`「${seen.get(to)}」和「${from}」都要改成「${to}」，会互相覆盖。一个新 id 只能有一个去处`)
    seen.set(to, from)
  }
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
/* 两位序号是**阅读顺序的标签**。两篇撞同一个序号时，谁在前由 slug 的字典序决定——
   而编译器当时是绿的（它只看行序递增）。这里只警告，不拦：
   号段撞车有时是有意的（补一篇插在中间），但撞了之后「谁在前」就不是你说了算的了。
   **看的是改完之后的样子**，不是现在的样子——现在当然不撞。 */
const after = fs.readdirSync(path.join(dir, 'stories'))
  .filter((f) => /^\d{2}-.*\.md$/.test(f))
  .map((f) => (moving.has(f.slice(0, -3)) ? `${map.get(f.slice(0, -3))}.md` : f))
const byNo = {}
for (const f of after) (byNo[f.slice(0, 2)] ||= []).push(f)
const dupNo = Object.entries(byNo).filter(([, v]) => v.length > 1)
if (dupNo.length) {
  console.log('\n  ⚠ 改完之后有两个故事共用同一个序号：')
  for (const [n, v] of dupNo) console.log(`      ${n}  ${v.join('  ')}`)
  console.log('    序号是阅读顺序的标签。撞了之后谁在前由 slug 的字典序决定，不由你决定。')
  console.log('    编译器不拦这个（它只看行序递增）——要么把序号错开，要么自己认下这个顺序。\n')
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

/* 要改字样的文件：内容目录全部 + `web/scripts`（示例和注释里会写 id）+ 根 README。
   注释原来就写着「README + 脚本里的示例」，代码却只 walk 了 `content`——
   于是 `new-story.mjs` 里那句示例 id 是**手改**的（就是 2026-10-14 那次提交），
   而手改的东西没人保证下次还改。

   **必须在改名之后重新走一遍**——文件名本身就是 id，
   先前的写法在改名之前就把路径收集好了，于是收进一张过期的单子：
   `cards/01-cidong.md` 已经叫 `02-cidong.md` 了，再去读旧名就 ENOENT。
   第一次真跑这个工具时就是这么崩的：文件全改完了，字样一处没改。 */
const SELF = fileURLToPath(import.meta.url)
const SCRIPT_DIRS = [path.join(ROOT, 'content'), path.join(ROOT, 'web', 'scripts')]
const collectTextFiles = () => {
  const out = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      /* **不改自己。** 这个文件里的 id 是用法示例和出事故的记录
         （「`cards/01-cidong.md` 已经叫 `02-cidong.md` 了」那句）。
         跟着一起改，等于把历史记录改成了当时没发生过的事。 */
      else if (/\.(md|mjs|js|jsx)$/.test(e.name) && p !== SELF) out.push(p)
    }
  }
  for (const d of SCRIPT_DIRS) walk(d)
  for (const f of ['README.md']) {
    const p = path.join(ROOT, f)
    if (fs.existsSync(p)) out.push(p)
  }
  return [...new Set(out)]
}
const textFiles = collectTextFiles()

console.log(`\n  改编号：${personId}`)
for (const [from, to] of map) console.log(`    ${from}  →  ${to}`)

console.log(`\n  文件：`)
for (const [a, , b] of tmp) console.log(`    ${path.relative(ROOT, a)}  →  ${path.relative(ROOT, b)}`)

/* **替换要带边界。** 无边界子串替换会咬到以旧 id 为前缀的别的 id：
   实测造一个 `03-chen.md`，跑 `03-chen=09-chen`，
   **没被点名**的 `03-chenliu.md` 的标题被改成了 `# 09-chenliu · 陈留起兵`，
   而文件没改名——一篇故事的标题从此和文件名对不上，全程无声。 */
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const at = (from) => new RegExp(esc(from) + '(?![0-9a-zA-Z-])', 'g')

console.log(`\n  字样：`)
const hits = []
for (const f of new Set(textFiles)) {
  const t = fs.readFileSync(f, 'utf8')
  let n = 0
  for (const from of moving) n += (t.match(at(from)) || []).length
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
    const re = at(from)
    if (re.test(t)) { t = t.replace(at(from), PH(i)); changed = true }
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
