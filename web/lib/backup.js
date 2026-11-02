/**
 * 本机数据的导出与导入。
 *
 * 产品边界是「不做账号、不做云同步」，那么换设备、清浏览器数据之前
 * **唯一的诚实办法**就是导出成一个文件再导入。不是锦上添花。
 *
 * 文件是**一个**而不是每样一个：读者不该为了搬家点三次。
 * 现在的载荷里只有 `progress`；收藏与朱批加进来时，在这里各加一个键，
 * 版本号不动——它们都是可选的顶层键，旧的导出文件照样能导入。
 */

import { progressStore } from '@/lib/progress'
import { libraryStore } from '@/lib/library'

export const BACKUP_SCHEMA = 1

const STORE_KEYS = [
  /* `count` 数的是**篇**，不是所有集合的键——复习标记也在 progress 载荷里，
     一起数会把「1 篇」说成「2 篇」。 */
  { key: 'progress', store: progressStore, label: '篇进度', count: (data) => Object.keys(data?.read || {}).length },
  { key: 'library', store: libraryStore, label: '篇收藏', count: (data) => Object.keys(data?.stars || {}).length },
]

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function buildBackup() {
  const payload = { app: 'guanshi', schema: BACKUP_SCHEMA, exportedAt: Date.now() }
  /* 每样数据带上**它自己的** schema：导入时按文件里的版本迁移，
     而不是假装它跟当前版本一样（否则旧备份永远走不到 migrate）。 */
  for (const { key, store } of STORE_KEYS) {
    payload[key] = { schema: store.version, data: store.exportJSON().data }
  }
  return payload
}

/** 每样数据有多少条，导入后给读者一句「带来了什么」。 */
function countOf(item, data) {
  if (!data || typeof data !== 'object') return 0
  return item.count(data)
}

/**
 * 导入：**合并**，不是替换。返回每一类各收下多少条。
 * 校验失败、写不进去都抛错——由调用方显示给读者，不能静默。
 */
export function applyBackup(payload) {
  if (!payload || payload.app !== 'guanshi' || typeof payload !== 'object') {
    throw new Error('这个文件不是观史导出的数据')
  }
  if (typeof payload.schema !== 'number' || payload.schema > BACKUP_SCHEMA) {
    throw new Error('这份数据来自更新的一版，当前版本读不了')
  }
  const result = {}
  for (const item of STORE_KEYS) {
    const { key, store } = item
    const entry = payload[key]
    if (!entry || typeof entry !== 'object' || !entry.data) continue
    const schema = typeof entry.schema === 'number' ? entry.schema : store.version
    const before = countOf(item, store.get())
    store.importJSON({ app: 'guanshi', schema, data: entry.data })
    const total = countOf(item, store.get())
    result[key] = { label: item.label, added: Math.max(0, total - before), total }
  }
  return result
}

export function downloadBackup() {
  const payload = buildBackup()
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `观史-本机记录-${stamp()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  /* 立刻 revoke 在 Safari 上会打断下载，挪到下一轮事件循环。 */
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function readBackupFile(file) {
  /* 先看大小再读：`importJSON` 的上限在解析之后才起作用，
     一个 200 MB 的文件会先把内存读爆。 */
  if (file.size > 2_000_000) throw new Error('这个文件太大了，超过 2 MB')
  const text = await file.text()
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new Error('这个文件读不出来，可能不是观史导出的 JSON')
  }
  return applyBackup(payload)
}
