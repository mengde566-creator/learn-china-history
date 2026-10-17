'use client'

import Link from 'next/link'
import { useSettings } from '@/lib/settings'

export default function SettingsClient() {
  const { settings, update, ready } = useSettings()

  return (
    <main className="wrap-narrow">
      <header className="page-head">
        <h1>设 置</h1>
        <p className="sub">保存在这台设备的浏览器里，不会上传。</p>
      </header>

      <section>
        <div className="set-row">
          <div className="info">
            <h3>场景区浅色</h3>
            <p>长时间阅读觉得暗场累，可以打开。</p>
          </div>
          <div className="ctrl">
            <button
              className="switch"
              role="switch"
              aria-checked={ready && settings.lightStage}
              aria-label="场景区浅色"
              onClick={() => update({ lightStage: !settings.lightStage })}
            />
          </div>
        </div>
      </section>

      <p style={{ marginTop: 30, fontSize: 13 }}>
        <Link href="/" style={{ color: 'var(--accent)' }}>← 返回总览</Link>
      </p>

      <div style={{ height: 90 }} />
    </main>
  )
}
