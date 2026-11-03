'use client'

import Link from 'next/link'
import { useProgress, resolveResume } from '@/lib/progress'

/**
 * 首页的「接着读」。
 *
 * **不止一条。** 读者常常同时读着好几个人（曹操读到第 6 段、高欢读到第 3 段），
 * 只显示「最近那一篇」等于替读者决定先读谁。这里按最近推进排，最多三条，
 * 其余的去书架看。
 *
 * 没有进度就整块不渲染：不给新读者画一个假的「继续阅读」。
 */
const MAX = 3

export default function ContinueRead({ index }) {
  const { progress, ready } = useProgress()
  if (!ready) return null

  const items = Object.entries(progress.read || {})
    .map(([key, record]) => {
      const meta = index[key]
      if (!meta || !record || typeof record.at !== 'number') return null
      const { beat } = resolveResume(meta.personId, meta.storyId, record, meta.beats)
      return { key, record, meta, beat, at: record.at }
    })
    .filter(Boolean)

  /* 先给没读完的；都读完了再给最近读完的那几篇。 */
  const reading = items.filter((item) => !item.record.done).sort((a, b) => b.at - a.at)
  const list = (reading.length ? reading : items.filter((item) => item.record.done).sort((a, b) => b.at - a.at)).slice(0, MAX)
  if (!list.length) return null

  return (
    <section className="sec">
      <h2 className="sec-title">接着读</h2>
      {list.map((item) => (
        <Link
          key={item.key}
          href={`/p/${item.meta.personId}/${item.meta.storyId}`}
          className="entry-card"
          style={{ marginBottom: 10 }}
        >
          <b>{item.record.done ? `读完了 · ${item.meta.storyName}` : `读到第 ${item.beat} 段 · ${item.meta.storyName}`}</b>
          <span>{item.meta.personName}　·　{item.record.done ? '可以再读一遍' : '接着往下读'}</span>
        </Link>
      ))}
      {reading.length > MAX && (
        <p className="footnote" style={{ marginTop: 6 }}>
          还有 {reading.length - MAX} 篇在读，<Link href="/shelf" style={{ color: 'var(--accent)' }}>都在书架</Link>。
        </p>
      )}
    </section>
  )
}
