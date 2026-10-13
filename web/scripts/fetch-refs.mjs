#!/usr/bin/env node
/**
 * 把核对用的参考文本取到 `.refs/`。
 *
 * **为什么要这一步。** 这个项目最大的风险从头到尾是同一件事：
 * 原文是 AI 依记忆写的。在此之前，全库「已核」段落是 **0**——
 * 因为没有任何一份可以拿来比对的文本，也没法证明比过。
 *
 * 现在能了：Project Gutenberg 上有公版的《三國志》和《三國志演義》，
 * 网址稳定、谁都能重新下一遍、谁都能复核我们的结论。
 *
 * 用法：
 *   node scripts/fetch-refs.mjs          # 缺什么取什么
 *   node scripts/fetch-refs.mjs --force  # 全部重取
 *
 * 取下来的东西进 `.gitignore`——它们可再生，而且不该塞进版本库。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIR = path.join(ROOT, '.refs')

const REFS = [
  {
    file: 'sgz.txt',
    title: '《三國志》陈寿（含裴松之注）',
    url: 'https://www.gutenberg.org/ebooks/25606.txt.utf-8',
    about: 'https://www.gutenberg.org/ebooks/25606',
    min: 1_000_000,
  },
  {
    file: 'sgyy.txt',
    title: '《三國志演義》罗贯中',
    url: 'https://www.gutenberg.org/ebooks/23950.txt.utf-8',
    about: 'https://www.gutenberg.org/ebooks/23950',
    min: 1_500_000,
  },
]

/* 大文件一次拉不完（实测会断在几百 KB）。断点续传接着拉，
   拉到字节数不再增长为止。 */
async function fetchOne(ref) {
  const out = path.join(DIR, ref.file)
  let prev = -1
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(ref.url, {
        headers: fs.existsSync(out) ? { Range: `bytes=${fs.statSync(out).size}-` } : {},
      })
      if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`)
      const chunk = Buffer.from(await r.arrayBuffer())
      if (chunk.length) fs.appendFileSync(out, chunk)
    } catch (e) {
      if (i > 6) throw e
    }
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0
    if (size >= ref.min && size === prev) return size
    prev = size
    process.stdout.write(`\r    ${ref.file}  ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
  const size = fs.statSync(out).size
  if (size < ref.min) throw new Error(`${ref.file} 只取到 ${size} 字节，不完整`)
  return size
}

fs.mkdirSync(DIR, { recursive: true })
const force = process.argv.includes('--force')

console.log('\n参考文本 → .refs/\n')
for (const ref of REFS) {
  const out = path.join(DIR, ref.file)
  if (fs.existsSync(out) && !force && fs.statSync(out).size >= ref.min) {
    console.log(`  ✓ ${ref.file}  已存在（${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB）`)
    continue
  }
  if (force && fs.existsSync(out)) fs.unlinkSync(out)
  const size = await fetchOne(ref)
  console.log(`\r  ✓ ${ref.file}  ${(size / 1024 / 1024).toFixed(2)} MB   ${ref.title}`)
}

console.log(`
  出处：
${REFS.map((r) => `    ${r.title}\n      ${r.about}`).join('\n')}

  **这些是转录本，不是实体书。** 它们能证明「我们写的和这份文件一致」，
  不能证明「这份文件绝对正确」。下一层核对（拿实体书）仍然没做。
  下一步：npm run check-sources
`)
