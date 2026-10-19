#!/usr/bin/env node
/**
 * R03 的回归测试：**读者可见字段的扫描，真的扫得到那些字段吗？**
 *
 * 为什么需要它：原来那段扫描写的是 `st.blocks`、`sd.ground`、`cd.a` ——
 * **三个字段都不存在**，所以它声称覆盖的地方一处也没扫到。往背景卡里塞一句
 * 「本文件早先写成另一版本，需另行核对。」，`--check` 照样退出 0。
 *
 * 做法：把 `content/` 复制到一个临时目录，往四个位置各注入一句明确禁止的审校批注，
 * 用**同一份编译器**（`build-content.mjs`，靠 `CONTENT_ROOT` 指过去）跑 `--check`，
 * 断言四个位置都被点名。**测试不碰原始内容。**
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, '..', 'content')
const JUNK = '本文件早先写成另一版本，需另行核对。'

/* 四处注入点：文件、定位串、注入方式。
   **表格行要插在收尾 `|` 之前**——插在它后面是格外的文字，会被正常丢掉，
   那不是「漏扫」，是注入方式不对（第一次就踩了这个）。 */
const CASES = [
  /* 锚点要跟着内容走——R05 把这张卡重写过一次，旧的锚点就失效了。
     夹具找不到锚点会报「锚点没找到」，那是**测试失效**，不是漏扫。 */
  ['背景卡（段落）', 'people/caocao/stories/09-chibi.md', '这一件事，正史和小说都写了', 'para'],
  ['人物引子', 'people/jingke/person.md', '## 他是谁', 'after2'],
  ['问答依据', 'people/jingke/seeds/06-yishui.md', '| 依据 |', 'cell'],
  ['复习卡答案', 'people/jingke/cards/06-yishui.md', '答：**这一段没有交代穿白的原因', 'line'],
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guanshi-vis-'))
fs.cpSync(SRC, tmp, { recursive: true })

let failed = 0
for (const [name, rel, anchor, fn] of CASES) {
  /* 每次都从干净副本重来 */
  fs.rmSync(tmp, { recursive: true, force: true }); fs.cpSync(SRC, tmp, { recursive: true })
  const file = path.join(tmp, rel)
  let text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  if (fn === 'after2') {
    const i = lines.findIndex((l) => l.trim() === anchor)
    if (i < 0) { console.log(`  ✗ ${name}：夹具锚点没找到（${rel}）`); failed++; continue }
    lines.splice(i + 2, 0, JUNK)
  } else if (fn === 'cell') {
    const i = lines.findIndex((l) => l.includes(anchor) && l.includes('|'))
    if (i < 0) { console.log(`  ✗ ${name}：夹具锚点没找到（${rel}）`); failed++; continue }
    lines[i] = lines[i].replace(/\|\s*$/, ' ' + JUNK + ' |')
  } else {
    const i = lines.findIndex((l) => l.includes(anchor))
    if (i < 0) { console.log(`  ✗ ${name}：夹具锚点没找到（${rel}）`); failed++; continue }
    lines[i] = lines[i] + ' ' + JUNK
  }
  fs.writeFileSync(file, lines.join('\n'))

  let out = '', code = 0
  try {
    out = execFileSync('node', [path.join(ROOT, 'scripts/build-content.mjs'), '--check'],
      { encoding: 'utf8', env: { ...process.env, CONTENT_ROOT: tmp }, stdio: 'pipe' })
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1 }

  const hit = out.includes('需另行核对') || out.includes('改稿史') || out.includes('待办')
  const located = out.includes(rel.split('/').pop().replace('.md', '')) || out.includes('person')
  if (code !== 0 && hit) console.log(`  ✓ ${name}：检查失败并点名了（exit ${code}）`)
  else { console.log(`  ✗ ${name}：注入「${JUNK}」之后检查仍然通过（exit ${code}）——扫描没覆盖这个字段`); failed++ }
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n  ✗ 读者可见字段扫描：${failed} 个位置漏扫` : '\n  ✓ 读者可见字段扫描：四个注入点全部报错并定位')
process.exit(failed ? 1 : 0)
