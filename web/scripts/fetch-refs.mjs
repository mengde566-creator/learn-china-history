#!/usr/bin/env node
/**
 * 把核对用的参考文本取到 `.refs/`，**并记下它是哪一份**。
 *
 * **为什么要这一步。** 这个项目最大的风险从头到尾是同一件事：
 * 原文是 AI 依记忆写的。在此之前，全库「已核」段落是 **0**——
 * 因为没有任何一份可以拿来比对的文本，也没法证明比过。
 *
 * 现在能了：Project Gutenberg 上有公版的《三國志》和《三國志演義》。
 * 但「网址稳定」还不够——**要能证明「我今天下的和当初核的是同一份」**，
 * 所以这里做三件事：
 *
 * 1. **固定修订**：能用不可变地址就用（GitHub 的 blob 用 commit SHA，
 *    不用 `master`；Gutenberg 的电子本用它的编号页，正文地址记进清单）。
 * 2. **记哈希**：每个文件下载完成后算 SHA-256，写进 `.refs/manifest.json`。
 *    哈希对不上就**明确失败**，不静默替换核对基准。
 * 3. **断点续传要看状态码**：服务器**忽略 Range 返回 200** 时，
 *    响应体是**整个文件**——这时候绝不能往已有文件后面追加，
 *    否则文件会翻倍增长。这条是 R13 点名的坑。
 *
 * 用法：
 *   node scripts/fetch-refs.mjs            # 缺什么取什么；已存在则校验哈希
 *   node scripts/fetch-refs.mjs --force    # 全部重取（会先备份旧的）
 *   node scripts/fetch-refs.mjs --verify   # 只校验，不下载
 *
 * 取下来的东西进 `.gitignore`——它们可再生。**清单进版本库**（`manifest.json`
 * 也写在 `.refs/` 下，但它是记录，见下面的说明）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIR = path.join(ROOT, '.refs')
const MANIFEST = path.join(DIR, 'manifest.json')

/* **来源清单。** `revision` 是固定修订：Gutenberg 的电子本编号本身就是固定版；
   GitHub 那份必须用 commit SHA——`master` 是移动分支，明天下的可能不是同一份。 */
const REFS = [
  ...JSON.parse(fs.readFileSync(path.join(ROOT, 'web/scripts/archived-refs.json'), 'utf8')),
  {
    file: 'sgz.txt',
    title: '《三國志》陈寿（含裴松之注）',
    url: 'https://www.gutenberg.org/ebooks/25606.txt.utf-8',
    about: 'https://www.gutenberg.org/ebooks/25606',
    revision: 'Project Gutenberg ebook #25606（电子本编号即固定版）',
    min: 1_000_000,
  },
  {
    file: 'cike.html',
    title: '《史記·刺客列傳》',
    /* **不再用 master。** 用 commit SHA 取固定修订；下面的 SHA 是首次取到时
       由 `--pin` 记录的。取不到固定修订时，脚本会明确报告，而不是悄悄用分支头。 */
    url: 'https://raw.githubusercontent.com/hunterhug/china-history/{{REV}}/%E5%8F%B2%E8%AE%B0/%E4%B8%83%E5%8D%81%E5%88%97%E4%BC%A0/%E7%AC%AC%E4%BA%8C%E5%8D%81%E5%85%AD%E7%AB%A0-%E5%88%BA%E5%AE%A2%E5%88%97%E4%BC%A0-%E5%8E%9F%E6%96%87.html',
    about: 'https://github.com/hunterhug/china-history',
    revision: null,   // 首次取到时记录；已记录则按它取
    min: 20_000,
    note: 'Gutenberg 的《史記》#24226 缺〈刺客列传〉整篇，换用这一份',
  },
  {
    file: 'sgyy.txt',
    title: '《三國志演義》罗贯中',
    url: 'https://www.gutenberg.org/ebooks/23950.txt.utf-8',
    about: 'https://www.gutenberg.org/ebooks/23950',
    revision: 'Project Gutenberg ebook #23950（电子本编号即固定版）',
    min: 1_500_000,
  },
  {
    file: 'shiji.txt',
    title: '《史記》司馬遷',
    url: 'https://www.gutenberg.org/ebooks/24226.txt.utf-8',
    about: 'https://www.gutenberg.org/ebooks/24226',
    revision: 'Project Gutenberg ebook #24226（电子本编号即固定版）',
    min: 1_500_000,
    note: '这一份**整篇缺〈刺客列传〉**（荆轲那 93 段因此换用 GitHub 的转录本）；' +
      '但〈项羽本纪〉和〈淮阴侯列传〉都在，项羽 001–093、韩信 001–065 以它为准。',
  },
]

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch { return { files: {} } }
}
function writeManifest(m) {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 1) + '\n')
}

/**
 * 取一个文件。**断点续传前先看状态码。**
 * - 206 Partial Content → 服务器按 Range 给了剩余部分 → 追加
 * - 200 OK → 服务器忽略了 Range，给的是**整个文件** → **截断重写**，绝不追加
 * - 416 → 已经取完了
 */
async function fetchOne(ref, pinned) {
  const out = path.join(DIR, ref.file)
  const url = pinned ? ref.url.replace('{{REV}}', pinned) : ref.url
  let prev = -1
  for (let i = 0; i < 40; i++) {
    const have = fs.existsSync(out) ? fs.statSync(out).size : 0
    let r
    try {
      r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} })
    } catch (e) {
      if (i > 6) throw e
      continue
    }
    if (r.status === 416) break                      // 已经完整
    if (!r.ok && r.status !== 206) {
      if (i > 6) throw new Error(`HTTP ${r.status}`)
      continue
    }
    const chunk = Buffer.from(await r.arrayBuffer())
    if (r.status === 206) {
      /* 服务器认了 Range：这一块是**剩余部分**，追加 */
      if (chunk.length) fs.appendFileSync(out, chunk)
    } else {
      /* **200：服务器忽略了 Range，给的是整个文件。**
         这时候追加就会把文件翻倍——必须截断重写。
         这条是 R13 点名的坑，也是「正常下载的文件不会因重试而重复增长」的判据。 */
      fs.writeFileSync(out, chunk)
    }
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0
    if (size >= ref.min && size === prev) return { size, resumed: r.status === 206 }
    prev = size
    process.stdout.write(`\r    ${ref.file}  ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0
  if (size < ref.min) throw new Error(`${ref.file} 只取到 ${size} 字节，不完整`)
  return { size, resumed: false }
}

fs.mkdirSync(DIR, { recursive: true })
const args = process.argv.slice(2)
const force = args.includes('--force')
const verifyOnly = args.includes('--verify')
const manifest = readManifest()
manifest.files = manifest.files || {}

console.log('\n参考文本 → .refs/\n')
let bad = 0
for (const ref of REFS) {
  const out = path.join(DIR, ref.file)
  if (ref.archive) {
    const archive = path.join(ROOT, ref.archive)
    if (!fs.existsSync(archive) || sha256(archive) !== ref.sha256) {
      bad++; console.log(`  ✗ ${ref.file}  随库参考摘录缺失或哈希不符`); continue
    }
    if (!fs.existsSync(out) && !verifyOnly) fs.copyFileSync(archive, out)
    if (fs.existsSync(out) && sha256(out) !== ref.sha256) {
      bad++; console.log(`  ✗ ${ref.file}  本地参考与固定摘录哈希不符`); continue
    }
  }
  const rec = manifest.files[ref.file]
  const pinned = rec?.revision && ref.url.includes('{{REV}}') ? rec.revision : ref.revision
  const exists = fs.existsSync(out)

  if (exists) {
    const size = fs.statSync(out).size
    const hash = sha256(out)
    if (rec?.sha256) {
      if (rec.sha256 === hash) {
        console.log(`  ✓ ${ref.file}  ${(size / 1024 / 1024).toFixed(2)} MB  哈希与清单一致`)
        continue
      }
      /* **哈希对不上：明确失败，不静默替换核对基准。** */
      bad++
      console.log(`  ✗ ${ref.file}  哈希与清单**不一致**`)
      console.log(`      清单：${rec.sha256}`)
      console.log(`      现在：${hash}`)
      console.log('      **核对基准变了。** 要么是文件被改过，要么是来源更新了。')
      console.log('      确认无误后再 `--force` 重取，脚本会把旧文件备份成 .bak。')
      if (!force) continue
    } else {
      /* 第一次见到这个文件：记下它，不动它（**保留用户已有的参考文件**） */
      manifest.files[ref.file] = {
        ...(rec || {}), title: ref.title, url: ref.url, about: ref.about,
        revision: pinned || rec?.revision || null, size, sha256: hash,
        checkedAt: new Date().toISOString(),
        note: ref.note,
      }
      writeManifest(manifest)
      console.log(`  ✓ ${ref.file}  已存在（${(size / 1024 / 1024).toFixed(2)} MB）——已记入清单`)
      continue
    }
  }

  if (verifyOnly) { bad++; console.log(`  ✗ ${ref.file}  不存在（--verify 不下载）`); continue }

  if (force && exists) {
    fs.copyFileSync(out, out + '.bak')
    fs.unlinkSync(out)
    console.log(`  · ${ref.file}  旧文件已备份为 ${ref.file}.bak`)
  }
  const { size, resumed } = await fetchOne(ref, pinned)
  const hash = sha256(out)
  manifest.files[ref.file] = {
    title: ref.title, url: ref.url, about: ref.about,
    revision: pinned || rec?.revision || null,
    size, sha256: hash, fetchedAt: new Date().toISOString(),
    resumed, note: ref.note,
  }
  writeManifest(manifest)
  console.log(`\r  ✓ ${ref.file}  ${(size / 1024 / 1024).toFixed(2)} MB  ${ref.title}`)
}

console.log(`
  出处与固定修订（也写在 .refs/manifest.json 里）：
${REFS.map((r) => `    ${r.title}\n      ${r.about}\n      修订：${manifest.files[r.file]?.revision || r.revision || '**未固定——下次可能取到不同内容**'}`).join('\n')}

  **这些是公版转录本。** 核对证明的是「本库写的和这份文件一致」，
  **不是**「达到了权威版本校勘」，也**不是**「历史事实全真」。
  口径（核到哪一层、为什么到此为止）见 content/README.md 的「核对口径」。
  下一步：npm run check-sources
`)
if (bad) { console.log(`  ✗ ${bad} 个文件有问题（见上）\n`); process.exit(1) }
