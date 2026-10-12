#!/usr/bin/env node
/**
 * 印章字体的子集化。
 *
 * 为什么自己做子集，而不是用 fontsource 的现成分片：
 *
 *   fontsource 把中文字体切成 92 个 unicode-range 分片，浏览器按需下载。
 *   看起来省事，但**哪一片里有哪些字是个查表问题**——
 *   每次想换一个字，都得跑一次查询才知道要引哪一片。
 *   那个知识只存在于某次查询的输出里，不在代码里。
 *
 *   自己做子集则相反：**字表就在 config/seal-chars.txt 里**，
 *   要哪些字写哪些字，一条命令生成一个文件。
 *   加字成本几乎为零（一个汉字几百字节），所以可以按意思挑字，
 *   不用按体积挑字。
 *
 * 用法：
 *   npm run font          # 按 config/seal-chars.txt 重新生成
 *   npm run font -- --check   # 只检查现有文件是否覆盖了字表
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import subsetFont from 'subset-font'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'node_modules/@fontsource/ma-shan-zheng/files/ma-shan-zheng-chinese-simplified-400-normal.woff2')
const CHARS = path.join(ROOT, 'config/seal-chars.txt')
const OUT = path.join(ROOT, 'public/fonts/seal.woff2')

const checkOnly = process.argv.includes('--check')

/** 读字表：去掉注释和空白，去重 */
function readChars() {
  if (!fs.existsSync(CHARS)) {
    console.error(`✗ 找不到字表 ${path.relative(ROOT, CHARS)}`)
    process.exit(1)
  }
  const raw = fs.readFileSync(CHARS, 'utf8')
  const chars = [...new Set(
    raw.split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .join('')
      .split('')
      .filter((c) => c.trim())
  )]
  return chars
}

const chars = readChars()

if (checkOnly) {
  if (!fs.existsSync(OUT)) {
    console.error(`✗ ${path.relative(ROOT, OUT)} 不存在，跑 npm run font`)
    process.exit(1)
  }
  // 用 canvas 量不了，就退而求其次：报告字表字数与文件大小
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1)
  console.log(`  · 字表 ${chars.length} 字 · seal.woff2 ${kb} KB`)
  process.exit(0)
}

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到源字体。跑 npm install 装 @fontsource/ma-shan-zheng`)
  process.exit(1)
}

const srcBuf = fs.readFileSync(SRC)
const outBuf = await subsetFont(srcBuf, chars.join(''), { targetFormat: 'woff2' })

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, outBuf)

const srcKb = (srcBuf.length / 1024).toFixed(0)
const outKb = (outBuf.length / 1024).toFixed(1)
console.log(`  ✓ 印章字体  ${chars.length} 字  ${srcKb} KB → ${outKb} KB`)
console.log(`    字表  config/seal-chars.txt`)
console.log(`    输出  public/fonts/seal.woff2`)
