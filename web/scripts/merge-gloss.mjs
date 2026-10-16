#!/usr/bin/env node
/**
 * 把 `gloss-parts/*.md` 按编号合进 `gloss.md`（表头保留，正文按编号排序）。
 *
 * 为什么要分片：325 段直译是很大的写作量，分片才能并行；
 * 而并行写同一个文件必然冲突。所以**分片各写各的，这一支脚本负责合**。
 *
 * 用法：node scripts/merge-gloss.mjs           # 合全部
 *       node scripts/merge-gloss.mjs caocao    # 只合一个人
 */
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const who = process.argv[2]
for (const p of who ? [who] : fs.readdirSync(path.join(ROOT, 'content/people'))) {
  const dir = path.join(ROOT, 'content/people', p, 'gloss-parts')
  const out = path.join(ROOT, 'content/people', p, 'gloss.md')
  if (!fs.existsSync(dir) || !fs.existsSync(out)) continue
  const head = fs.readFileSync(out, 'utf8').split('| 编号 | 原文 | 直译 |')[0]
  /* **原文栏由这一支脚本填，不从分片里读。**
     理由：这一栏完全由 `source.md` 决定，人抄一遍只会引入错误——
     实测第一次就抄错两行（`202` 少 314 字、`204` 少 69 字，从被截断的终端显示里手抄的）。
     分片里那一栏现在只是**写作时的参照**，合的时候一律用 `source.md` 覆盖。
     （编译器另有一条闸门核对两栏逐字相同，防的是有人直接改 `gloss.md`。） */
  const segs = {}
  const src = path.join(ROOT, 'content/people', p, 'source.md')
  if (fs.existsSync(src)) {
    for (const l of fs.readFileSync(src, 'utf8').split('\n')) {
      const c = l.split('|').slice(1, -1).map((x) => x.trim())
      if (c.length >= 3 && /^\d{3}$/.test(c[0])) segs[c[0]] = c[1]
    }
  }
  const rows = new Map()
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = l.match(/^\|\s*(\d{3})\s*\|([^|]*)\|([^|]*)\|\s*$/)
      if (!m) continue
      const [, id, , gloss] = m
      const text = segs[id] ?? m[2].trim()
      rows.set(id, `| ${id} | ${text} | ${gloss.trim()} |`)
    }
  }
  if (!rows.size) { console.log(`  ${p}: 分片里没有行，跳过`); continue }
  const body = [...rows.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, l]) => l)
  fs.writeFileSync(out, head + '| 编号 | 原文 | 直译 |\n|---|---|---|\n' + body.join('\n') + '\n')
  console.log(`  ${p}: 合了 ${rows.size} 段`)
}
