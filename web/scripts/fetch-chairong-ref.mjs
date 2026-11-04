#!/usr/bin/env node
/**
 * 柴荣的参考文本是**拼接型**：底本横跨《旧五代史·周书·世宗纪》一至六，
 * 上游把那六卷拆成六个章节页，`fetch-refs.mjs` 一个条目只能对一份文件，
 * 所以由这个脚本取六份、抽正文、拼成 `.refs/chai-rong.txt` 一份。
 *
 * **为什么不做成"手工拼一次然后忘掉"。** 参考文本在 `.refs/` 里、不进版本库，
 * 换一台机器就没得核。校验能跑，靠的必须是有人能按脚本重新取到同一份东西。
 * 所以这里和 `fetch-refs.mjs` 保持同一套口径：
 *
 * 1. **固定提交**：GitHub 的 URL 用 commit SHA，不用 `master`。
 * 2. **记哈希**：取完算 SHA-256，写进 `.refs/manifest.json`；
 *    对不上就明确失败，不静默替换核对基准。
 * 3. **会重算、不重拼**：每次都从上游取，拼出来的内容和本地一样才算过；
 *    不一样就停下来问人，而不是悄悄改写。
 *
 * 用法：
 *   npm run refs:chairong            # 取六份并核对；缺就写，不一样就报错
 *   npm run refs:chairong -- --verify  # 只核对（本地 vs 清单 vs 上游），不写文件
 *   npm run refs:chairong -- --force   # 确认要换基准时用：旧文件备份成 .bak
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIR = path.join(ROOT, '.refs')
const OUT = path.join(DIR, 'chai-rong.txt')
const MANIFEST = path.join(DIR, 'manifest.json')
const FILE = 'chai-rong.txt'

/* 固定提交：第六章文件是 2026-08 的样子，之后上游若有改动，这里也不会跟着漂。
   换提交要同时改 manifest 里的 revision——否则「我们核的是哪一份」就说不清了。 */
const REVISION = 'eeb7ad7eb0fc04b10caf6e15c3427bd1648455fb'
const REPO = 'https://github.com/hunterhug/china-history'
const DIR_URL = `https://raw.githubusercontent.com/hunterhug/china-history/${REVISION}/${encodeURI('旧五代史/后周')}`
const CHAPTERS = [
  ['第五章-世宗纪一-原文.html', '世宗纪一'],
  ['第六章-世宗纪二-原文.html', '世宗纪二'],
  ['第七章-世宗纪三-原文.html', '世宗纪三'],
  ['第八章-世宗纪四-原文.html', '世宗纪四'],
  ['第九章-世宗纪五-原文.html', '世宗纪五'],
  ['第十章-世宗纪六-原文.html', '世宗纪六'],
]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const args = process.argv.slice(2)
const verifyOnly = args.includes('--verify')
const force = args.includes('--force')

/* HTML 实体：这几卷正文里有 &amp; 一类记号，直接剥标签会把它留在正文里。 */
const decode = (s) => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

/** 章节页的正文都在 <p> 里；页面自带的导航行（「← 阿星星的首页」「首页」）不是正文。 */
function paragraphsOf(html) {
  const out = []
  for (const m of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = decode(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (!text || text === '首页' || text.startsWith('←')) continue
    out.push(text)
  }
  return out
}

async function fetchChapter(file, title) {
  const url = `${DIR_URL}/${encodeURI(file)}`
  let last
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const html = await r.text()
      const paras = paragraphsOf(html)
      if (!paras.length) throw new Error('没抽到正文段落')
      console.log(`  · ${title}  ${paras.length} 段  ${(html.length / 1024).toFixed(0)} KB`)
      return paras
    } catch (e) {
      last = e
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  throw new Error(`${title} 取不到：${last?.message || last}`)
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return { files: {} } }
}
function writeManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n')
}

const manifest = readManifest()
manifest.files = manifest.files || {}
const rec = manifest.files[FILE]
const exists = fs.existsSync(OUT)
const local = exists ? fs.readFileSync(OUT) : null
const localHash = local ? sha256(local) : null

console.log('\n柴荣参考文本（拼接）→ .refs/chai-rong.txt\n')
console.log(`  固定提交 ${REVISION.slice(0, 12)}  ·  ${CHAPTERS.length} 章`)

let parts = []
try {
  for (const [file, title] of CHAPTERS) parts.push(...await fetchChapter(file, title))
} catch (e) {
  console.log(`\n  ✗ ${e.message}`)
  if (exists && localHash) {
    console.log(`  本地有一份 ${(local.length / 1024).toFixed(0)} KB 的文件（${localHash.slice(0, 12)}…）。
  取不到上游时它仍可用于 check-sources，但「能否复现」这次没有验证。`)
  }
  process.exit(1)
}
const text = parts.join('\n\n') + '\n'
const fetched = Buffer.from(text, 'utf8')
const fetchedHash = sha256(fetched);

if (verifyOnly) {
  let bad = 0
  if (!exists) { bad++; console.log('  ✗ 本地没有 chai-rong.txt') }
  if (!rec) { bad++; console.log('  ✗ 清单里没有这条记录') }
  if (localHash && localHash !== fetchedHash) { bad++; console.log('  ✗ 本地文件与刚取到的内容不同') }
  if (localHash && rec && rec.sha256 && rec.sha256 !== localHash) { bad++; console.log('  ✗ 本地文件与清单哈希不同') }
  if (rec && rec.revision && rec.revision !== REVISION) { bad++; console.log('  ✗ 清单里的固定提交与脚本不同') }
  if (bad) { console.log(`\n  ✗ ${bad} 处不一致\n`); process.exit(1) }
  console.log(`\n  ✓ 本地、清单、上游三者一致（${parts.length} 段，${(fetched.length / 1024).toFixed(0)} KB，sha256 ${fetchedHash.slice(0, 12)}…）\n`)
  process.exit(0)
}

/* 已经有一份、而且和刚取到的一模一样：只补记清单，不动文件。 */
if (exists && localHash === fetchedHash) {
  if (!rec || rec.sha256 !== localHash || rec.revision !== REVISION) {
    manifest.files[FILE] = {
      title: '《舊五代史·周書·世宗紀》一至六（拼接）',
      url: `${DIR_URL}`,
      about: REPO,
      revision: REVISION,
      size: fetched.length,
      sha256: fetchedHash,
      checkedAt: new Date().toISOString(),
      note: '由 scripts/fetch-chairong-ref.mjs 取六个章节页、抽 <p> 正文后拼接；不是单一上游文件。',
    }
    writeManifest(manifest)
    console.log('  · 清单已补记/更新')
  }
  console.log(`\n  ✓ ${FILE}  ${(fetched.length / 1024).toFixed(0)} KB  与上游一致，未改动`)
  console.log(`    sha256 ${fetchedHash}\n`)
  process.exit(0)
}

/* 有本地文件但内容不同：**核对基准变了，停下来问人。** */
if (exists && localHash !== fetchedHash && !force) {
  console.log(`  ✗ 本地 ${FILE} 与刚取到的内容不同`)
  console.log(`      本地：${(local.length / 1024).toFixed(0)} KB  ${localHash.slice(0, 16)}…`)
  console.log(`      上游：${(fetched.length / 1024).toFixed(0)} KB  ${fetchedHash.slice(0, 16)}…`)
  console.log('      核对基准变了。确认无误后加 --force 重取（旧文件会备份成 .bak）。')
  process.exit(1)
}

if (exists && force) {
  fs.copyFileSync(OUT, OUT + '.bak')
  console.log(`  · 旧文件已备份为 ${FILE}.bak`)
}
fs.mkdirSync(DIR, { recursive: true })
fs.writeFileSync(OUT, fetched)
manifest.files[FILE] = {
  title: '《舊五代史·周書·世宗紀》一至六（拼接）',
  url: `${DIR_URL}`,
  about: REPO,
  revision: REVISION,
  size: fetched.length,
  sha256: fetchedHash,
  fetchedAt: new Date().toISOString(),
  note: '由 scripts/fetch-chairong-ref.mjs 取六个章节页、抽 <p> 正文后拼接；不是单一上游文件。',
}
writeManifest(manifest)
console.log(`\n  ✓ ${FILE}  ${(fetched.length / 1024).toFixed(0)} KB  ${parts.length} 段`)
console.log(`    sha256 ${fetchedHash}`)
console.log('\n  下一步：npm run check-sources\n')
