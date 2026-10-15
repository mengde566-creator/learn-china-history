/* 批量操作的安全闸门。
 *
 * 为什么有这个东西：
 * 2026-10-15，我在一个**有未提交工作**的仓库里跑了一个会重写 30 多个文件的脚本。
 * 脚本自己也有 bug（不是幂等的，跑第二遍把已经改好的编号又映射了一次），
 * 于是唯一的退路是 `git checkout -- content/people/caocao/`——
 * 而那条命令会把**未提交的东西一起带走**。一个子智能体刚做完、已经验证过的一整篇
 * 正文（9 个情节点、419 行）就这么没了（后来从 /tmp 的手工备份里取回）。
 *
 * 三个错叠在一起：脚本不幂等 · 正则会伤到无关的列 · 在有未提交工作时回滚。
 * 前两个防不住所有情况，第三个**可以机械地防住**——这就是这个文件的作用。
 *
 * 用法：任何会改很多文件的脚本，开头调用它。
 *
 *   import { requireCleanTree } from './lib/guard.mjs'
 *   requireCleanTree('全库重编号')                        // 脏就退出，什么都不做
 *   requireCleanTree('全库重编号', { allow: ['content/people/'] })  // 允许某几处脏
 */
import { execSync } from 'node:child_process'

const ROOT = new URL('../../..', import.meta.url).pathname

export function dirtyPaths() {
  const out = execSync('git status --porcelain', { encoding: 'utf8', cwd: ROOT })
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
}

export function requireCleanTree(what, { allow = [], force = false } = {}) {
  const dirty = dirtyPaths().filter((p) => !allow.some((a) => p.startsWith(a)))
  if (!dirty.length) return true
  if (force || process.argv.includes('--force')) {
    console.error(`⚠ ${what}：工作区有 ${dirty.length} 处未提交的改动，被 --force 放行。`)
    return true
  }
  console.error(
    `\n✗ 拒绝执行「${what}」：工作区有 ${dirty.length} 处未提交的改动。\n\n` +
      dirty.slice(0, 10).map((p) => '    ' + p).join('\n') +
      (dirty.length > 10 ? `\n    …还有 ${dirty.length - 10} 处` : '') +
      `\n\n  批量脚本一旦写坏，唯一的退路是 git checkout —— 而它会把上面这些一起带走。\n` +
      `  先提交，再跑。真要跑就加 --force，并且自己知道代价。\n`
  )
  process.exit(1)
}
