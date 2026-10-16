#!/usr/bin/env node
/**
 * 白话字数统计。**唯一口径，写在这里，别每次现写。**
 *
 * 为什么要固定：2026-10-15 我在不同轮里用了三种口径报同一批数，
 * 一个子智能体试了 20 多种字段组合都复现不出来。三个坑：
 *
 *   1. **小节标题有三种**：曹操「## 二、情节点」、荆轲「## 二、正文」、
 *      荆轲 06-yishui「## 二、场景正文：五个情节点」。写死一个就切不到，
 *      切不到会退化成只数文件头（荆轲一度低到 22–68）。
 *      → 按 `## 二、` 找，不按名字找。
 *   2. **只数 `>` 行**（白话叙述）。表格里的「原文」块、`| 说明 |` 行、
 *      背景卡、映射表都不算——它们不是白话。
 *   3. **切到下一个 `## ` 为止**，别把后面的小节带进来。
 *
 * 用法：node scripts/words.mjs            # 全库
 *       node scripts/words.mjs caocao     # 一个人
 */
import fs from 'node:fs'
import path from 'node:path'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const who = process.argv[2]
const people = who ? [who] : fs.readdirSync(path.join(ROOT, 'content/people'))
for (const p of people) {
  const dir = path.join(ROOT, 'content/people', p, 'stories')
  if (!fs.existsSync(dir)) continue
  console.log(`══ ${p}`)
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue
    const L = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
    const a = L.findIndex((l) => /^## 二、/.test(l))
    if (a < 0) { console.log(`  ${f.replace('.md', '').padEnd(18)} （没有「二、」小节）`); continue }
    const b = L.findIndex((l, i) => i > a && /^## /.test(l))
    const n = L.slice(a, b < 0 ? L.length : b)
      .filter((l) => l.startsWith('> '))
      .reduce((acc, l) => acc + (l.slice(2).match(/[\u4e00-\u9fff]/g) || []).length, 0)
    console.log(`  ${f.replace('.md', '').padEnd(18)} ${String(n).padStart(5)}`)
  }
}
