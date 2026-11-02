'use client'

import Link from 'next/link'
import { useProgress, resolveResume } from '@/lib/progress'

/**
 * 首页的「接着读」。
 *
 * 读者回来第一屏应该能回答「我上次读到哪」——原来这件事要再点两级才看得到。
 * **没有进度就整块不渲染**：不给新读者画一个假的「继续阅读」。
 *
 * 只显示一条（`at` 最新的那一篇），不是列表：首页是门厅，不是书架。
 */
export default function ContinueRead({ index }) {
  const { progress, ready } = useProgress()
  if (!ready) return null

  let latest = null
  for (const [key, record] of Object.entries(progress.read || {})) {
    if (!record || typeof record.at !== 'number') continue
    const meta = index[key]
    if (!meta) continue // 内容库里已经没有这一篇了
    if (!latest || record.at > latest.at) latest = { key, record, meta, at: record.at }
  }
  if (!latest) return null

  const { record, meta } = latest
  const { beat } = resolveResume(meta.personId, meta.storyId, record, meta.beats)
  const label = record.done ? `读完了 · ${meta.storyName}` : `读到第 ${beat} 段 · ${meta.storyName}`

  return (
    <section className="sec">
      <h2 className="sec-title">接着读</h2>
      <Link href={`/p/${meta.personId}/${meta.storyId}`} className="entry-card">
        <b>{label}</b>
        <span>{record.done ? `${meta.personName} · 可以再读一遍` : `${meta.personName} · 接着往下读`}</span>
      </Link>
    </section>
  )
}
