'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSettings } from '@/lib/settings'

/* 导航只放全局入口。
   具体的人物 / 故事靠面包屑走——把某篇故事写进导航，
   等于假设它永远是唯一那篇。 */
const LINKS = [
  { href: '/', label: '总览' },
  { href: '/settings', label: '设置' },
]

export default function Nav() {
  const pathname = usePathname()
  const { settings, update, ready } = useSettings()

  return (
    <nav className="nav">
      <span className="brand">观 史</span>
      <span className="tag">无 AI 模式</span>
      <div className="links">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>
            {l.label}
          </Link>
        ))}
        <button
          className="theme"
          onClick={() => update({ lightStage: !settings.lightStage })}
          title="切换明暗"
          suppressHydrationWarning
        >
          {ready && settings.lightStage ? '浅色' : '暗场'}
        </button>
      </div>
    </nav>
  )
}
