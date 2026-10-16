#!/usr/bin/env node
/**
 * 界面文案闸门：**读者看得见的字里，不许有「写给作者的话」。**
 *
 * 为什么单开一支：内容闸门（build-content.mjs）查的是 markdown 编译出来的字段，
 * **够不着 JSX 里的字符串**。用户连着指出的问题里，有一半住在界面代码里
 * （「铺陈 26 行 · 逐行依据 26 条」那个人页的自述、⑥ 页顶上那一整块、
 * `/settings` 的「还没有接入」）。
 *
 * 三类：**作者的待办 · 改稿史 · 内部行话**。
 * 去注释之后再抽字符串——注释里写这些是正当的（那正是给作者看的）。
 */
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const JUNK = [
  [/需(?:另行|再)核对|待核|待查|待写|待定|待补|尚未核|TODO|FIXME/, '作者的待办'],
  [/本文件(?:早先|原来|原先)|早先写成|上一版|改过之后|原先写/, '改稿史'],
  [/逐行依据\s*\d|铺陈\s*\d+\s*行|情节点\s*\d+\s*个|种子\s*\d+\s*条|复习卡\s*\d+\s*张/, '零件计数'],
  [/还没有接入|暂未接入|尚未接入/, '开发状态'],
  [/口径|闸门|编译器|校验|自查|越界/, '内部行话'],
]
const files = []
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  if (['node_modules', '.next'].includes(e.name) || e.name.startsWith('.')) return
  const p = path.join(d, e.name)
  e.isDirectory() ? walk(p) : /\.(jsx|js)$/.test(e.name) && files.push(p)
})
walk(path.join(ROOT, 'components')); walk(path.join(ROOT, 'app'))
let bad = 0, n = 0
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8')
  /* 去注释——注释里写这些是正当的。 */
  s = s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const rel = f.replace(ROOT + '/', '')
  const texts = [
    ...[...s.matchAll(/>([^<>{}]{3,})</g)].map((m) => m[1]),
    ...[...s.matchAll(/(?:title|label|placeholder|alt|aria-label)\s*[:=]\s*["'`]([^"'`]{3,})["'`]/g)].map((m) => m[1]),
    ...[...s.matchAll(/["'`]([^"'`\n]{6,})["'`]/g)].map((m) => m[1]),
  ]
  for (const t of texts) {
    if (!/[\u4e00-\u9fff]/.test(t)) continue
    n++
    for (const [re, kind] of JUNK) {
      const m = t.trim().match(re)
      if (m) { console.log(`  ✗ ${rel}\n      [${kind}]「${m[0]}」  …${t.trim().slice(0, 70)}…`); bad++; break }
    }
  }
}
console.log(bad
  ? `\n  ✗ 界面文案：检查了 ${n} 条，${bad} 条是「写给作者的话」——读者不办这件事、没有上一版、也不需要知道我们怎么做的。`
  : `  ✓ 界面文案  检查了 ${n} 条，没有「写给作者的话」`)
process.exit(bad ? 1 : 0)
