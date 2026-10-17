'use client'

import Link from 'next/link'
import { useProgress } from '@/lib/progress'

/**
 * 「最近阅读」——上次读到哪一篇、第几段（R12）。
 * 进度只在本机，所以这一块在服务端渲染时是空的，挂载后才出现。
 */
export default function RecentRead({ personId, stories }) {
  const { progress, ready } = useProgress()
  if (!ready) return null
  const mine = Object.entries(progress.read || {})
    .map(([k, v]) => {
      const [pid, sid] = k.split('/')
      if (pid !== personId) return null
      const meta = stories.find((s) => s.id === sid)
      return meta ? { ...meta, ...v } : null
    })
    .filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
  if (!mine.length) return null
  const last = mine[0]
  return (
    <section className="sec" style={{ marginTop: 8 }}>
      <h2 className="sec-h">最近阅读</h2>
      <Link href={`/p/${personId}/${last.id}`} className="entry-card">
        <b>{last.done ? `读完了 · ${last.name}` : `读到第 ${last.beat} 段 · ${last.name}`}</b>
        <span>{last.done ? '可以再读一遍，或者去复习卡' : '接着往下读'}</span>
      </Link>
    </section>
  )
}
