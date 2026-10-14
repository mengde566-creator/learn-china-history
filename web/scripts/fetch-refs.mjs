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
    file: 'cike.html',
    title: '《史記·刺客列傳》',
    url: 'https://raw.githubusercontent.com/hunterhug/china-history/master/%E5%8F%B2%E8%AE%B0/%E4%B8%83%E5%8D%81%E5%88%97%E4%BC%A0/%E7%AC%AC%E4%BA%8C%E5%8D%81%E5%85%AD%E7%AB%A0-%E5%88%BA%E5%AE%A2%E5%88%97%E4%BC%A0-%E5%8E%9F%E6%96%87.html',
    about: 'https://github.com/hunterhug/china-history',
    min: 20_000,
    note: 'Gutenberg 的《史記》#24226 缺〈刺客列传〉整篇，换用这一份',
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

  **这些是公版转录本。** 核对证明的是「本库写的和这份文件一致」。
  口径（核到哪一层、为什么到此为止）见 content/README.md 的「核对口径」。
  下一步：npm run check-sources
`)
