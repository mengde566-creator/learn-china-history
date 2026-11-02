'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSettings } from '@/lib/settings'
import { clearProgress } from '@/lib/progress'

export default function SettingsClient() {
  const { settings, update, ready } = useSettings()
  /* 清除是不可逆的：按下之后先问一次。
     原来一点就把 130 篇的阅读位置和复习标记全删掉，没有任何找回路径。 */
  const [confirming, setConfirming] = useState(false)
  const clearBtnRef = useRef(null)
  const cancelRef = useRef(null)

  /* 确认态：焦点落在**取消**上——这是销毁数据的确认，
     默认焦点给「确定」会让按住 Enter 的人直接删掉。
     退出时（Esc / 取消 / 确认）都把焦点还给原来的「清除」。 */
  useEffect(() => {
    if (!confirming) return
    cancelRef.current?.focus()
    const escape = (event) => {
      if (event.key !== 'Escape') return
      setConfirming(false)
      requestAnimationFrame(() => clearBtnRef.current?.focus())
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [confirming])

  const backToClear = () => {
    setConfirming(false)
    requestAnimationFrame(() => clearBtnRef.current?.focus())
  }

  return (
    <main className="wrap-narrow">
      <header className="page-head">
        <h1>设 置</h1>
        <p className="sub">保存在这台设备的浏览器里，不会上传。</p>
      </header>

      <section>
        {/* **本地数据的出口。** 阅读进度和复习状态存在这台设备上，
            读者要能看见它、也要能清掉它（R12 验收）。 */}
        <div className="set-row">
          <div className="info">
            <h3>阅读进度与复习状态</h3>
            <p aria-live="polite">
              {confirming
                ? '清掉之后无法恢复：各篇读到第几段、哪些卡已标过，都会归零。'
                : '存在这台设备的浏览器里，不会上传。清掉之后，各篇的阅读位置和复习标记都归零。'}
            </p>
          </div>
          <div className="ctrl">
            {confirming ? (
              <div className="ctrl-actions">
                <button
                  className="set-btn danger"
                  aria-label="确定清除本机阅读数据"
                  onClick={() => { clearProgress(); backToClear() }}
                >
                  确定清除
                </button>
                <button
                  ref={cancelRef}
                  className="set-btn"
                  aria-label="取消清除本机阅读数据"
                  onClick={backToClear}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                ref={clearBtnRef}
                className="set-btn"
                onClick={() => setConfirming(true)}
                aria-label="清除本机保存的阅读数据"
              >
                清 除
              </button>
            )}
          </div>
        </div>

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
